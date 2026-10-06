terraform {
  required_version = ">= 1.10"
  backend "s3" {
    bucket       = "marketplace-terraform-state"
    key          = "prod/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.80" }
    archive    = { source = "hashicorp/archive", version = "~> 2.6" }
    confluent  = { source = "confluentinc/confluent", version = "~> 2.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    upstash    = { source = "upstash/upstash", version = "~> 1.5" }
  }
}

# Credentials come from the environment (AWS_PROFILE / OIDC, CONFLUENT_CLOUD_API_KEY/SECRET,
# CLOUDFLARE_API_TOKEN, UPSTASH_EMAIL/UPSTASH_API_KEY) - never from tfvars.
provider "aws" {
  region = "eu-central-1"
  default_tags {
    tags = { project = "marketplace", env = "prod", managed_by = "terraform" }
  }
}
provider "confluent" {}
provider "cloudflare" {}
provider "upstash" {}
