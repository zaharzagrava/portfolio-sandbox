# One-time: the remote-state bucket every env uses (run once per AWS account with local state, then never again).
# Locking uses S3 conditional writes (`use_lockfile`, Terraform ≥ 1.10) - no DynamoDB lock table needed.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
}

provider "aws" { region = "eu-central-1" }

variable "bucket" {
  type    = string
  default = "marketplace-terraform-state"
}

resource "aws_s3_bucket" "state" {
  bucket = var.bucket
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" } # recover from a bad apply / corrupted state
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
