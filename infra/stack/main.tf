# The whole marketplace for ONE environment. envs/demo and envs/prod differ only in the sizing they pass (D16).

locals {
  tags = { project = "marketplace", env = var.env, managed_by = "terraform" }

  # HTTP services behind the ALB (paths → target group); everything else falls through to core.
  http_services = {
    core          = { port = 8000, paths = [], priority = 100, deregistration_delay = 30 }
    "sse-gateway" = { port = 8000, paths = ["/api/streams*", "/api/live/*/events", "/api/payment/stream", "/api/assistant/*"], priority = 10, deregistration_delay = 60 }
    "public-api"  = { port = 8000, paths = ["/v1/*"], priority = 20, deregistration_delay = 30 }
    bff           = { port = 8000, paths = ["/api/bff/*", "/api/graphql"], priority = 30, deregistration_delay = 30 }
    collab        = { port = 8000, paths = ["/collab/*"], priority = 40, deregistration_delay = 60 }
  }
  worker_services = ["worker", "projector", "payment-processor"]

  # Same list as infra/docker/elasticmq/elasticmq.conf (local mirror).
  queues = {
    "notifications-email"     = { visibility_seconds = 60, max_receive = 5 }
    "notifications-sms"       = { visibility_seconds = 60, max_receive = 5 }
    "notifications-push"      = { visibility_seconds = 60, max_receive = 5 }
    "notifications-marketing" = { visibility_seconds = 120, max_receive = 3 }
    "delivery-offer-timeouts" = { visibility_seconds = 30, max_receive = 5 }
    "chat-offline-notify"     = { visibility_seconds = 30, max_receive = 3 }
    "webhook-deliveries.fifo" = { visibility_seconds = 180, max_receive = 8, fifo = true } # ≥ 6 × Lambda timeout (30 s)
    "media-processing"        = { visibility_seconds = 360, max_receive = 3 }              # 6 × 60 s
    "catalog-imports"         = { visibility_seconds = 300, max_receive = 3 }
    "video-transcode"         = { visibility_seconds = 900, max_receive = 3 }
    "integration-sync"        = { visibility_seconds = 300, max_receive = 5 }
    "integration-backfill"    = { visibility_seconds = 900, max_receive = 3 }
    "crawl-fetch"             = { visibility_seconds = 60, max_receive = 3 }
    "function-test-runs"      = { visibility_seconds = 120, max_receive = 2 }
    "knowledge-ingest"        = { visibility_seconds = 300, max_receive = 5 }
    "onboarding-documents"    = { visibility_seconds = 720, max_receive = 5 } # 6 × 120 s
    "bulk-stock-updates"      = { visibility_seconds = 120, max_receive = 5 }
  }

  domain_aggregates = ["api", "auctions", "billing", "chat", "courier", "feed", "ledger", "links", "live", "llm", "media", "orders", "pickup", "products", "search", "shops", "stories", "usage"]
  kafka_topics = merge(
    { "payments.requests" = var.kafka_partitions.payments, "payments.responses" = var.kafka_partitions.payments, "payments.dlq" = 1 },
    { for a in local.domain_aggregates : "${a}.events" => var.kafka_partitions.domain },
    { "analytics.events" = var.kafka_partitions.domain, "ads.clicks" = var.kafka_partitions.domain, "ads.click-aggregates" = var.kafka_partitions.domain },
  )

  lambda_manifest = try(jsondecode(file(var.lambda_manifest_path)), [])
  lambdas         = { for l in local.lambda_manifest : l.name => l }
}

module "network" {
  source              = "../modules/network"
  name                = "marketplace-${var.env}"
  azs                 = var.azs
  nat_per_az          = var.network.nat_per_az
  interface_endpoints = var.network.interface_endpoints
  tags                = local.tags
}

module "secrets" {
  source = "../modules/secrets"
  env    = var.env
  tags   = local.tags
}

module "storage" {
  source         = "../modules/s3_cloudfront"
  env            = var.env
  public_key_pem = var.cloudfront_public_key_pem
  tags           = local.tags
}

module "ecr" {
  source       = "../modules/ecr"
  repositories = concat(keys(local.http_services), local.worker_services, ["migrator"])
  tags         = local.tags
}

module "github" {
  source               = "../modules/github_oidc"
  env                  = var.env
  github_repo          = var.github_repo
  create_provider      = var.create_github_oidc_provider
  ecr_repository_arns  = module.ecr.repository_arns
  artifacts_bucket_arn = module.storage.artifacts_bucket_arn
  tags                 = local.tags
}

# --- TLS: ACM certificate validated through Cloudflare DNS ---
resource "aws_acm_certificate" "api" {
  domain_name       = var.api_hostname
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
  tags = local.tags
}

resource "cloudflare_record" "acm" {
  for_each = { for o in aws_acm_certificate.api.domain_validation_options : o.domain_name => o }
  zone_id  = var.cloudflare_zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  content  = trimsuffix(each.value.resource_record_value, ".")
  proxied  = false
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for r in cloudflare_record.acm : r.hostname]
}

module "edge" {
  source            = "../modules/edge"
  env               = var.env
  zone_id           = var.cloudflare_zone_id
  api_hostname      = var.api_hostname
  cdn_hostname      = var.cdn_hostname
  alb_dns_name      = module.alb.dns_name
  cloudfront_domain = module.storage.cdn_domain
}

data "cloudflare_ip_ranges" "this" {}

module "alb" {
  source            = "../modules/alb"
  name              = "marketplace-${var.env}"
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn
  services          = local.http_services
  # prod: the origin only answers Cloudflare (DDoS/WAF can't be bypassed); demo stays open for debugging.
  allowed_ingress_cidrs = var.env == "prod" ? data.cloudflare_ip_ranges.this.ipv4_cidr_blocks : ["0.0.0.0/0"]
  tags                  = local.tags
}

module "kafka" {
  source       = "../modules/confluent"
  env          = var.env
  availability = var.kafka_availability
  topics       = local.kafka_topics
}

module "sqs" {
  source      = "../modules/sqs"
  env         = var.env
  queues      = local.queues
  kms_key_arn = module.secrets.kms_key_arn
  tags        = local.tags
}

module "dynamodb" {
  source          = "../modules/dynamodb"
  env             = var.env
  definitions_dir = "${path.module}/../../packages/backend/dynamodb"
  kms_key_arn     = module.secrets.kms_key_arn
  tags            = local.tags
}

module "keyspaces" {
  source = "../modules/keyspaces"
  env    = var.env
  tags   = local.tags
}

# Least privilege by role: HTTP apps produce work, workers consume it.
locals {
  api_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sqs:SendMessage", "sqs:GetQueueUrl"], Resource = values(module.sqs.queue_arns) },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:ConditionCheckItem"], Resource = concat(module.dynamodb.table_arns, [for a in module.dynamodb.table_arns : "${a}/index/*"]) },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], Resource = "${module.storage.media_bucket_arn}/*" },
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = module.storage.media_bucket_arn },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = module.secrets.kms_key_arn },
    ]
  })
  worker_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:DeleteMessageBatch", "sqs:ChangeMessageVisibility", "sqs:ChangeMessageVisibilityBatch", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueues"], Resource = module.sqs.all_arns },
      { Effect = "Allow", Action = ["sqs:ListQueues"], Resource = "*" },
      { Effect = "Allow", Action = ["dynamodb:*Item", "dynamodb:Query", "dynamodb:Batch*", "dynamodb:TransactWriteItems"], Resource = concat(module.dynamodb.table_arns, [for a in module.dynamodb.table_arns : "${a}/index/*"]) },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${module.storage.media_bucket_arn}/*" },
      { Effect = "Allow", Action = ["ses:SendEmail", "ses:SendRawEmail"], Resource = "*" },
      { Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = module.secrets.kms_key_arn },
    ]
  })
}

module "observability" {
  source                    = "../modules/observability"
  env                       = var.env
  alb_arn_suffix            = module.alb.alb_arn_suffix
  target_group_arn_suffixes = module.alb.target_group_arn_suffixes
  dlq_names                 = module.sqs.dlq_names
  asg_names                 = { for s in local.worker_services : s => "marketplace-${var.env}-${s}" }
  pager_email               = var.pager_email
  managed_prometheus        = var.managed_prometheus
  tags                      = local.tags
}

resource "aws_codedeploy_app" "ec2" {
  name             = "marketplace-${var.env}"
  compute_platform = "Server"
  tags             = local.tags
}

module "http_service" {
  source   = "../modules/asg_service"
  for_each = local.http_services

  env                        = var.env
  app                        = each.key
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  instance_types             = var.services[each.key].instance_types
  min_size                   = var.services[each.key].min
  max_size                   = var.services[each.key].max
  desired_capacity           = var.services[each.key].desired
  on_demand_base             = var.services[each.key].on_demand_base
  spot_percentage_above_base = var.services[each.key].spot_percentage_above_base
  ecr_repository_url         = module.ecr.repository_urls[each.key]
  artifacts_bucket           = module.storage.artifacts_bucket
  secret_arn                 = module.secrets.secret_arns["app"]
  kms_key_arn                = module.secrets.kms_key_arn
  target_group_arn           = module.alb.target_group_arns[each.key]
  target_group_name          = module.alb.target_group_names[each.key]
  listener_arn               = module.alb.listener_arn
  alb_security_group_id      = module.alb.security_group_id
  # SSE/WebSocket instances are connection-bound, not CPU-bound: scale earlier.
  scaling                = contains(["sse-gateway", "collab"], each.key) ? { cpu_target = 40 } : { cpu_target = 55 }
  extra_policy_json      = local.api_policy
  alarm_names            = module.observability.alarm_names[each.key]
  amp_remote_write_url   = module.observability.amp_remote_write_url
  trace_sampling_percent = var.trace_sampling_percent
  tags                   = local.tags
  depends_on             = [aws_codedeploy_app.ec2]
}

module "worker_service" {
  source   = "../modules/asg_service"
  for_each = toset(local.worker_services)

  env                        = var.env
  app                        = each.key
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.private_subnet_ids
  instance_types             = var.services[each.key].instance_types
  min_size                   = var.services[each.key].min
  max_size                   = var.services[each.key].max
  desired_capacity           = var.services[each.key].desired
  on_demand_base             = var.services[each.key].on_demand_base
  spot_percentage_above_base = var.services[each.key].spot_percentage_above_base
  ecr_repository_url         = module.ecr.repository_urls[each.key]
  artifacts_bucket           = module.storage.artifacts_bucket
  secret_arn                 = module.secrets.secret_arns["app"]
  kms_key_arn                = module.secrets.kms_key_arn
  # Projector scales on consumer lag (F-05), not CPU; the metric is published by ADOT from kafka lag.
  scaling                = each.key == "projector" ? { metric_name = "ConsumerLag", metric_ns = "Marketplace/Kafka", metric_target = 5000 } : { cpu_target = 60 }
  extra_policy_json      = local.worker_policy
  amp_remote_write_url   = module.observability.amp_remote_write_url
  trace_sampling_percent = var.trace_sampling_percent
  tags                   = local.tags
}

locals {
  app_security_groups = concat(
    [for s in module.http_service : s.security_group_id],
    [for s in module.worker_service : s.security_group_id],
    [module.db_migrate.security_group_id, aws_security_group.lambda.id],
  )
}

resource "aws_security_group" "lambda" {
  name   = "marketplace-${var.env}-lambda"
  vpc_id = module.network.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

module "rds" {
  source                    = "../modules/rds"
  env                       = var.env
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.data_subnet_ids
  client_security_group_ids = local.app_security_groups
  instance_class            = var.rds.instance_class
  multi_az                  = var.rds.multi_az
  read_replica              = var.rds.read_replica
  rds_proxy                 = var.rds.rds_proxy
  kms_key_arn               = module.secrets.kms_key_arn
  tags                      = local.tags
}

module "redis" {
  source                    = "../modules/elasticache"
  env                       = var.env
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.data_subnet_ids
  client_security_group_ids = local.app_security_groups
  node_type                 = var.redis.node_type
  replicas                  = var.redis.replicas
  tags                      = local.tags
}

module "search_analytics" {
  source                    = "../modules/search_analytics"
  env                       = var.env
  vpc_id                    = module.network.vpc_id
  subnet_ids                = module.network.data_subnet_ids
  client_security_group_ids = local.app_security_groups
  mode                      = var.search_analytics_mode
  tags                      = local.tags
}

module "db_migrate" {
  source                  = "../modules/db_migrate"
  env                     = var.env
  vpc_id                  = module.network.vpc_id
  subnet_ids              = module.network.private_subnet_ids
  migrator_repository_url = module.ecr.repository_urls["migrator"]
  migrator_repository_arn = [for a in module.ecr.repository_arns : a if endswith(a, "/marketplace/migrator")][0]
  secret_arn              = module.secrets.secret_arns["app"]
  kms_key_arn             = module.secrets.kms_key_arn
  tags                    = local.tags
}

module "lambdas" {
  source             = "../modules/lambda_sqs_worker"
  env                = var.env
  functions          = local.lambdas
  queue_arns         = module.sqs.queue_arns
  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.lambda.id]
  secret_arn         = module.secrets.secret_arns["app"]
  kms_key_arns       = [module.secrets.kms_key_arn]
  extra_policy_json  = local.worker_policy
  alarm_topic_arn    = module.observability.pager_topic_arn
  tags               = local.tags
}

module "budgets" {
  source            = "../modules/budgets"
  env               = var.env
  monthly_limit_usd = var.budget_usd
  emails            = var.budget_emails
}
