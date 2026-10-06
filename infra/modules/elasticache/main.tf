# Redis (Valkey engine, Redis-protocol compatible) for stock buckets, locks, rate limits, streams, caches.
# `noeviction`: losing a stock bucket or lock to LRU eviction is a correctness bug (runbook RedisMemoryHigh);
# caches carry TTLs instead. Cluster mode is off today (one ioredis client); every multi-key script already
# uses {hash tags}, so enabling cluster mode later is a client switch, not a key redesign.

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "client_security_group_ids" { type = list(string) }
variable "node_type" { type = string }
variable "replicas" {
  description = "0 = single node (demo). ≥ 1 enables Multi-AZ automatic failover."
  type        = number
  default     = 0
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals { name = "marketplace-${var.env}" }

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "redis" {
  name   = "${local.name}-redis"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.client_security_group_ids
  }
  tags = var.tags
}

resource "aws_elasticache_parameter_group" "this" {
  name   = "${local.name}-valkey8"
  family = "valkey8"
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
  parameter {
    name  = "notify-keyspace-events"
    value = ""
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = local.name
  description                = "marketplace ${var.env} state + cache"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = var.node_type
  num_cache_clusters         = 1 + var.replicas
  automatic_failover_enabled = var.replicas > 0
  multi_az_enabled           = var.replicas > 0
  parameter_group_name       = aws_elasticache_parameter_group.this.name
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  snapshot_retention_limit   = var.env == "prod" ? 3 : 0
  apply_immediately          = var.env != "prod"
  tags                       = var.tags
}

output "primary_endpoint" { value = aws_elasticache_replication_group.this.primary_endpoint_address }
output "replication_group_id" { value = aws_elasticache_replication_group.this.id }
