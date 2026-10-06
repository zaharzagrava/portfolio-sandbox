variable "env" { type = string }
variable "azs" { type = list(string) }
variable "github_repo" { type = string }
variable "create_github_oidc_provider" {
  type    = bool
  default = false
}
variable "cloudflare_zone_id" { type = string }
variable "api_hostname" { type = string }
variable "cdn_hostname" { type = string }
variable "cloudfront_public_key_pem" { type = string }
variable "pager_email" {
  type    = string
  default = null
}
variable "budget_usd" { type = number }
variable "budget_emails" { type = list(string) }

variable "network" {
  type = object({
    nat_per_az          = bool
    interface_endpoints = bool
  })
}

variable "services" {
  description = "Sizing per app (D25 capacity models)."
  type = map(object({
    instance_types             = list(string)
    min                        = number
    max                        = number
    desired                    = number
    on_demand_base             = number
    spot_percentage_above_base = number
  }))
}

variable "rds" {
  type = object({
    instance_class = string
    multi_az       = bool
    read_replica   = bool
    rds_proxy      = bool
  })
}

variable "redis" {
  type = object({
    node_type = string
    replicas  = number
  })
}

variable "search_analytics_mode" { type = string }
variable "kafka_availability" { type = string }
variable "kafka_partitions" {
  type = object({
    payments = number
    domain   = number
  })
}
variable "managed_prometheus" { type = bool }
variable "trace_sampling_percent" { type = number }
variable "lambda_manifest_path" {
  description = "manifest.json emitted by `pnpm build:lambdas` (single source: apps/lambdas/src/lambdas.manifest.ts)."
  type        = string
}
