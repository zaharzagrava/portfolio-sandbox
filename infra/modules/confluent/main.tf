# Kafka on Confluent Cloud (D12 - MSK not used). Moved from the old infra/main.tf and extended from the
# 3 payment topics to every domain topic (`<aggregate>.events`, F-05) plus analytics/ads streams.
# Partitions = max consumer parallelism of a group; increase only for NEW topics (keyed ordering).

terraform {
  required_providers {
    confluent = { source = "confluentinc/confluent", version = "~> 2.0" }
  }
}

variable "env" { type = string }
variable "cloud_region" {
  type    = string
  default = "eu-central-1"
}
variable "availability" {
  description = "SINGLE_ZONE (demo) | MULTI_ZONE (prod)"
  type        = string
}
variable "topics" {
  description = "topic => partitions"
  type        = map(number)
}

resource "confluent_environment" "this" {
  display_name = "marketplace-${var.env}"
}

resource "confluent_kafka_cluster" "this" {
  display_name = "marketplace-${var.env}"
  availability = var.availability
  cloud        = "AWS"
  region       = var.cloud_region
  # Basic (usage-billed, single zone) for demo; Standard (multi-zone SLA) for prod.
  dynamic "basic" {
    for_each = var.availability == "SINGLE_ZONE" ? [1] : []
    content {}
  }
  dynamic "standard" {
    for_each = var.availability == "SINGLE_ZONE" ? [] : [1]
    content {}
  }
  environment { id = confluent_environment.this.id }
}

resource "confluent_service_account" "app" {
  display_name = "marketplace-${var.env}-app"
  description  = "Backend apps, projector, edge workers"
}

resource "confluent_role_binding" "app" {
  principal   = "User:${confluent_service_account.app.id}"
  role_name   = "CloudClusterAdmin"
  crn_pattern = confluent_kafka_cluster.this.rbac_crn
}

resource "confluent_api_key" "app" {
  display_name = "marketplace-${var.env}-app"
  owner {
    id          = confluent_service_account.app.id
    api_version = confluent_service_account.app.api_version
    kind        = confluent_service_account.app.kind
  }
  managed_resource {
    id          = confluent_kafka_cluster.this.id
    api_version = confluent_kafka_cluster.this.api_version
    kind        = confluent_kafka_cluster.this.kind
    environment { id = confluent_environment.this.id }
  }
  depends_on = [confluent_role_binding.app]
}

resource "confluent_kafka_topic" "this" {
  for_each         = var.topics
  topic_name       = each.key
  partitions_count = each.value
  rest_endpoint    = confluent_kafka_cluster.this.rest_endpoint
  kafka_cluster { id = confluent_kafka_cluster.this.id }
  credentials {
    key    = confluent_api_key.app.id
    secret = confluent_api_key.app.secret
  }
  config = {
    "retention.ms" = endswith(each.key, ".dlq") ? "1209600000" : "604800000" # 14 d for DLQs, 7 d otherwise (replays, D26)
  }
}

output "bootstrap_endpoint" { value = confluent_kafka_cluster.this.bootstrap_endpoint }
output "rest_endpoint" { value = confluent_kafka_cluster.this.rest_endpoint }
output "api_key" { value = confluent_api_key.app.id }
output "api_secret" {
  value     = confluent_api_key.app.secret
  sensitive = true
}
