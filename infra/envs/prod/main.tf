# prod: sized from the section capacity models (D25) - e.g. SD-42: 50k concurrent assistant streams at ~5k
# per instance → sse-gateway max 20; checkout 10k RPS at ~800 RPS per m7g.large core → max 40.
# Multi-AZ everything stateful, NAT per AZ, interface endpoints, managed OpenSearch, AMP.
module "stack" {
  source = "../../stack"

  env                       = "prod"
  azs                       = ["eu-central-1a", "eu-central-1b"]
  github_repo               = var.github_repo
  cloudflare_zone_id        = var.cloudflare_zone_id
  api_hostname              = "api.${var.domain}"
  cdn_hostname              = "cdn.${var.domain}"
  cloudfront_public_key_pem = var.cloudfront_public_key_pem
  pager_email               = var.pager_email
  budget_usd                = 15000
  budget_emails             = var.budget_emails

  network = { nat_per_az = true, interface_endpoints = true }

  services = {
    core                = { instance_types = ["m7g.large", "m6g.large"], min = 4, max = 40, desired = 4, on_demand_base = 4, spot_percentage_above_base = 50 }
    "sse-gateway"       = { instance_types = ["c7g.large", "c6g.large"], min = 4, max = 20, desired = 4, on_demand_base = 4, spot_percentage_above_base = 0 }
    "public-api"        = { instance_types = ["m7g.large"], min = 2, max = 10, desired = 2, on_demand_base = 2, spot_percentage_above_base = 50 }
    bff                 = { instance_types = ["c7g.large"], min = 2, max = 10, desired = 2, on_demand_base = 2, spot_percentage_above_base = 50 }
    collab              = { instance_types = ["c7g.large"], min = 2, max = 6, desired = 2, on_demand_base = 2, spot_percentage_above_base = 0 }
    worker              = { instance_types = ["c7g.xlarge", "c6g.xlarge", "m7g.xlarge"], min = 2, max = 20, desired = 2, on_demand_base = 1, spot_percentage_above_base = 70 }
    projector           = { instance_types = ["c7g.large", "c6g.large"], min = 2, max = 12, desired = 2, on_demand_base = 1, spot_percentage_above_base = 70 }
    "payment-processor" = { instance_types = ["m7g.large"], min = 2, max = 6, desired = 2, on_demand_base = 2, spot_percentage_above_base = 0 }
  }

  rds   = { instance_class = "db.r7g.2xlarge", multi_az = true, read_replica = true, rds_proxy = true }
  redis = { node_type = "cache.r7g.large", replicas = 2 }

  search_analytics_mode  = "managed"
  kafka_availability     = "MULTI_ZONE"
  kafka_partitions       = { payments = 64, domain = 12 }
  managed_prometheus     = true
  trace_sampling_percent = 5
  lambda_manifest_path   = "${path.root}/../../../packages/backend/dist/lambda-bundles/manifest.json"
}

output "github_vars" { value = module.stack.github_vars }
output "app_config" { value = module.stack.app_config }
