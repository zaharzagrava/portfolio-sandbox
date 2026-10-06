terraform {
  required_version = ">= 1.9"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.80" }
    archive    = { source = "hashicorp/archive", version = "~> 2.6" }
    confluent  = { source = "confluentinc/confluent", version = "~> 2.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    upstash    = { source = "upstash/upstash", version = "~> 1.5" }
  }
}
