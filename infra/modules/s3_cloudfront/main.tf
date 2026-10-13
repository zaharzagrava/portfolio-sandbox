# Media + artifacts storage. Media is private; CloudFront reads it through Origin Access Control and serves
# public variants (content-hashed, immutable) and signed URLs/cookies for private media (SD-10/SD-25/SD-26)
# using the key group below. Raw uploads, KYC documents and imports never go through CloudFront.

variable "env" { type = string }
variable "public_key_pem" {
  description = "Public half of the CloudFront signing key (private half lives in the app secret)."
  type        = string
}
variable "price_class" {
  type    = string
  default = "PriceClass_100"
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals { prod = var.env == "prod" }

resource "aws_s3_bucket" "media" {
  bucket        = "marketplace-${var.env}-media"
  force_destroy = !local.prod
  tags          = var.tags
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "marketplace-${var.env}-artifacts"
  force_destroy = !local.prod
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "all" {
  for_each                = { media = aws_s3_bucket.media.id, artifacts = aws_s3_bucket.artifacts.id }
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = local.prod ? "Enabled" : "Suspended" }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
  # S29 AS-60: uploaded originals stay private and move to cheaper tiers by age (derived variants stay hot: they are
  # what the media origin serves). Abandoned multipart and unfinished uploads are aborted by the rule above.
  rule {
    id     = "photo-originals-tiering"
    status = "Enabled"
    filter { prefix = "media/originals/" }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 180
      storage_class = "GLACIER"
    }
  }
  rule {
    id     = "imports-expire"
    status = "Enabled"
    filter { prefix = "imports/" }
    expiration { days = 7 } # catalog import files are processed within minutes; reports are re-generatable
  }
  rule {
    id     = "kyc-raw-safety-net"
    status = "Enabled"
    filter { prefix = "kyc/" }
    expiration { days = 120 } # the purge job (SD-44) deletes at verification + 30 d; this catches abandoned onboarding
  }
  rule {
    id     = "old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  cors_rule {
    allowed_methods = ["PUT", "POST"]
    allowed_origins = ["https://*"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "marketplace-${var.env}-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_public_key" "signing" {
  name        = "marketplace-${var.env}-signing"
  encoded_key = var.public_key_pem
}

resource "aws_cloudfront_key_group" "signing" {
  name  = "marketplace-${var.env}-signing"
  items = [aws_cloudfront_public_key.signing.id]
}

data "aws_cloudfront_cache_policy" "optimized" { name = "Managed-CachingOptimized" } # no cookies, no query string in the key

# S29 AS-60 / FR-070: the media origin never lets a browser sniff a stored file into something else, and tells every
# cache that a content-addressed variant never changes. (The stored objects carry the same Cache-Control; this makes
# the header true for anything the origin serves, whatever was written.)
resource "aws_cloudfront_response_headers_policy" "media" {
  name = "marketplace-${var.env}-media"
  security_headers_config {
    content_type_options { override = true } # X-Content-Type-Options: nosniff
  }
  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=31536000, immutable"
      override = false # videos/* playlists set their own
    }
  }
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = var.price_class
  comment         = "marketplace ${var.env} media"

  origin {
    origin_id                = "media"
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  # Public, content-hashed variants: cache forever.
  default_cache_behavior {
    target_origin_id       = "media"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media.id
    compress                   = true
  }

  # HLS playback (SD-26): signed cookies scoped to /videos/<id>/ (Q79).
  ordered_cache_behavior {
    path_pattern           = "videos/*"
    target_origin_id       = "media"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    trusted_key_groups     = [aws_cloudfront_key_group.signing.id]
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
  tags = var.tags
}

data "aws_iam_policy_document" "media" {
  statement {
    actions   = ["s3:GetObject"]
    # Only derived, publishable objects: image variants and HLS playlists/segments. Originals, video sources
    # (videos/<id>/source), KYC files, imports and exports are unreachable through CloudFront.
    resources = ["${aws_s3_bucket.media.arn}/media/derived/*", "${aws_s3_bucket.media.arn}/videos/*.m3u8", "${aws_s3_bucket.media.arn}/videos/*.ts"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.media.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media.json
}

output "media_bucket" { value = aws_s3_bucket.media.bucket }
output "media_bucket_arn" { value = aws_s3_bucket.media.arn }
output "artifacts_bucket" { value = aws_s3_bucket.artifacts.bucket }
output "artifacts_bucket_arn" { value = aws_s3_bucket.artifacts.arn }
output "cdn_domain" { value = aws_cloudfront_distribution.media.domain_name }
output "key_group_id" { value = aws_cloudfront_key_group.signing.id }
