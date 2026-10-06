variable "github_repo" { type = string }
variable "cloudflare_zone_id" { type = string }
variable "domain" { type = string }
variable "cloudfront_public_key_pem" { type = string }
variable "pager_email" {
  type    = string
  default = null
}
variable "budget_emails" { type = list(string) }
