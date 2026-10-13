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
variable "web_origins" {
  description = "S30: origins of the web app that may play unlisted video with credentials (CORS on the unlisted path only)."
  type        = list(string)
  default     = ["https://marketplace.dev"]
}
variable "video_aliases" {
  description = "S30: host names of the video delivery host (stream.marketplace.dev); empty uses the default CloudFront name."
  type        = list(string)
  default     = []
}
variable "video_certificate_arn" {
  description = "S30: ACM certificate (us-east-1) for video_aliases; empty uses the default CloudFront certificate."
  type        = string
  default     = ""
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
  # S30 AS-60: the original of a video (vsrc/<id>/source) is private, moves to infrequent access after 30 days and is
  # removed by the purge job (deleted/expired at once, a failed one after 7 days). Outputs under p/ and u/ stay hot.
  rule {
    id     = "video-sources-tiering"
    status = "Enabled"
    filter { prefix = "vsrc/" }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
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

# S30 G8 / AS-60: the video delivery host. Public outputs live under p/<videoId>/ (no signature), unlisted ones under
# u/<videoId>/ (a signed cookie for that path is required for every object); the original (vsrc/<videoId>/source) is
# outside every behavior and outside the bucket policy below, so the origin cannot read it. The host sets no cookie
# (CloudFront never does), answers `nosniff` and the immutable cache header, and allows CORS with credentials on the
# unlisted path only (the cookie must travel with the segment requests).
resource "aws_cloudfront_response_headers_policy" "video_public" {
  name = "marketplace-${var.env}-video-public"
  security_headers_config {
    content_type_options { override = true }
  }
  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers { items = ["*"] }
    access_control_allow_methods { items = ["GET", "HEAD", "OPTIONS"] }
    access_control_allow_origins { items = ["*"] }
    access_control_max_age_sec = 3600
    origin_override            = true
  }
  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=31536000, immutable"
      override = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "video_unlisted" {
  name = "marketplace-${var.env}-video-unlisted"
  security_headers_config {
    content_type_options { override = true }
  }
  cors_config {
    access_control_allow_credentials = true
    access_control_allow_headers { items = ["*"] }
    access_control_allow_methods { items = ["GET", "HEAD", "OPTIONS"] }
    access_control_allow_origins { items = var.web_origins }
    access_control_max_age_sec = 3600
    origin_override            = true
  }
  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=31536000, immutable"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "video" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = var.price_class
  comment         = "marketplace ${var.env} video"
  aliases         = var.video_aliases

  origin {
    origin_id                = "video"
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  # Everything that is neither p/ nor u/ needs a signature, and the bucket policy grants nothing outside p/ and u/:
  # the private source prefix cannot be fetched whatever is signed.
  default_cache_behavior {
    target_origin_id           = "video"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.video_unlisted.id
    trusted_key_groups         = [aws_cloudfront_key_group.signing.id]
  }

  ordered_cache_behavior {
    path_pattern               = "p/*"
    target_origin_id           = "video"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.video_public.id
    compress                   = false
  }

  ordered_cache_behavior {
    path_pattern               = "u/*"
    target_origin_id           = "video"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.video_unlisted.id
    trusted_key_groups         = [aws_cloudfront_key_group.signing.id]
    compress                   = false
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    cloudfront_default_certificate = var.video_certificate_arn == ""
    acm_certificate_arn            = var.video_certificate_arn == "" ? null : var.video_certificate_arn
    ssl_support_method             = var.video_certificate_arn == "" ? null : "sni-only"
    minimum_protocol_version       = var.video_certificate_arn == "" ? null : "TLSv1.2_2021"
  }
  tags = var.tags
}

data "aws_iam_policy_document" "media" {
  statement {
    actions   = ["s3:GetObject"]
    # Only derived, publishable objects: image variants and HLS playlists/segments. Originals, video sources
    # (vsrc/<id>/source), KYC files, imports and exports are unreachable through CloudFront.
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
  # S30: the video distribution reads the two delivery prefixes and nothing else.
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/p/*", "${aws_s3_bucket.media.arn}/u/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.video.arn]
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
output "video_cdn_domain" { value = aws_cloudfront_distribution.video.domain_name }
output "key_group_id" { value = aws_cloudfront_key_group.signing.id }
