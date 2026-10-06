# demo: smallest viable (D16) - a portfolio environment that exercises every path at low traffic.
# Single NAT, single-AZ Kafka, one shared ES+ClickHouse node, Spot wherever interruption is harmless.
module "stack" {
  source = "../../stack"

  env                         = "demo"
  azs                         = ["eu-central-1a", "eu-central-1b"]
  github_repo                 = var.github_repo
  create_github_oidc_provider = true # account-wide; prod (same account) reuses it
  cloudflare_zone_id          = var.cloudflare_zone_id
  api_hostname                = "api.demo.${var.domain}"
  cdn_hostname                = "cdn.demo.${var.domain}"
  cloudfront_public_key_pem   = var.cloudfront_public_key_pem
  pager_email                 = var.pager_email
  budget_usd                  = 350
  budget_emails               = var.budget_emails

  network = { nat_per_az = false, interface_endpoints = false }

  services = {
    core                = { instance_types = ["t4g.small", "t4g.medium"], min = 1, max = 3, desired = 1, on_demand_base = 1, spot_percentage_above_base = 100 }
    "sse-gateway"       = { instance_types = ["t4g.small"], min = 1, max = 2, desired = 1, on_demand_base = 0, spot_percentage_above_base = 100 }
    "public-api"        = { instance_types = ["t4g.small"], min = 1, max = 2, desired = 1, on_demand_base = 0, spot_percentage_above_base = 100 }
    bff                 = { instance_types = ["t4g.small"], min = 1, max = 2, desired = 1, on_demand_base = 0, spot_percentage_above_base = 100 }
    collab              = { instance_types = ["t4g.small"], min = 1, max = 1, desired = 1, on_demand_base = 0, spot_percentage_above_base = 100 }
    worker              = { instance_types = ["t4g.medium", "c7g.medium"], min = 1, max = 3, desired = 1, on_demand_base = 0, spot_percentage_above_base = 100 }
    projector           = { instance_types = ["t4g.small"], min = 1, max = 2, desired = 1, on_demand_base = 0, spot_percentage_above_base = 100 }
    "payment-processor" = { instance_types = ["t4g.small"], min = 1, max = 2, desired = 1, on_demand_base = 1, spot_percentage_above_base = 0 }
  }

  rds   = { instance_class = "db.t4g.small", multi_az = false, read_replica = false, rds_proxy = false }
  redis = { node_type = "cache.t4g.micro", replicas = 0 }

  search_analytics_mode  = "shared_ec2"
  kafka_availability     = "SINGLE_ZONE"
  kafka_partitions       = { payments = 6, domain = 3 }
  managed_prometheus     = false
  trace_sampling_percent = 20
  lambda_manifest_path   = "${path.root}/../../../packages/backend/dist/lambda-bundles/manifest.json"
}

output "github_vars" { value = module.stack.github_vars }
output "app_config" { value = module.stack.app_config }
