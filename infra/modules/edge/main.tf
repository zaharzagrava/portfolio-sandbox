# Edge layer kept from the old infra/main.tf: Cloudflare (DNS proxied to the ALB, TLS + WAF + DDoS at the edge,
# Worker routes for packages/edge-be) and Upstash Redis (edge-side cache/rate limits reachable over HTTPS).
# The Worker script itself is deployed by wrangler from packages/edge-be; Terraform only routes to it.

terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    upstash    = { source = "upstash/upstash", version = "~> 1.5" }
  }
}

variable "env" { type = string }
variable "zone_id" { type = string }
variable "api_hostname" {
  description = "e.g. api.example.com / api.demo.example.com"
  type        = string
}
variable "cdn_hostname" { type = string }
variable "alb_dns_name" { type = string }
variable "cloudfront_domain" { type = string }
variable "worker_name" {
  type    = string
  default = "marketplace-edge"
}
variable "worker_routes" {
  description = "Paths served at the edge (short links, analytics collect, widget loader)."
  type        = list(string)
  default     = ["/l/*", "/collect", "/widget/v1/*"]
}

resource "cloudflare_record" "api" {
  zone_id = var.zone_id
  name    = var.api_hostname
  type    = "CNAME"
  content = var.alb_dns_name
  proxied = true
}

resource "cloudflare_record" "cdn" {
  zone_id = var.zone_id
  name    = var.cdn_hostname
  type    = "CNAME"
  content = var.cloudfront_domain
  proxied = false # CloudFront is already the CDN; double-proxying breaks signed cookies' domain
}

resource "cloudflare_worker_route" "edge" {
  for_each    = toset(var.worker_routes)
  zone_id     = var.zone_id
  pattern     = "${var.api_hostname}${each.key}"
  script_name = "${var.worker_name}-${var.env}"
}

resource "upstash_redis_database" "edge" {
  database_name = "marketplace-${var.env}-edge"
  region        = "eu-central-1"
  tls           = true
}

output "upstash_endpoint" { value = upstash_redis_database.edge.endpoint }
output "upstash_rest_token" {
  value     = upstash_redis_database.edge.rest_token
  sensitive = true
}
