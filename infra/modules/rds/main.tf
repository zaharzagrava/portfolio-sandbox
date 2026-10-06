# Postgres (source of truth): PostGIS + pgvector + pg_trgm + btree_gist are RDS-supported extensions
# (created by migrations). Data subnets only, no public access, TLS forced.
# Knobs by env: Multi-AZ, read replica (statements/exports/RAG eval read from DB_READ_HOST), RDS Proxy
# (connection multiplexing once ASG scale-out × pool size approaches max_connections - runbook PostgresConnectionsHigh).

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "client_security_group_ids" { type = list(string) }
variable "instance_class" { type = string }
variable "allocated_storage" {
  type    = number
  default = 50
}
variable "max_allocated_storage" {
  type    = number
  default = 500
}
variable "multi_az" {
  type    = bool
  default = false
}
variable "read_replica" {
  type    = bool
  default = false
}
variable "rds_proxy" {
  type    = bool
  default = false
}
variable "kms_key_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  name = "marketplace-${var.env}"
  prod = var.env == "prod"
}

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = var.subnet_ids
  tags       = var.tags
}

resource "aws_security_group" "db" {
  name   = "${local.name}-postgres"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.client_security_group_ids
  }
  tags = var.tags
}

resource "aws_db_parameter_group" "this" {
  name   = "${local.name}-pg17"
  family = "postgres17"
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
  parameter {
    name  = "lock_timeout"
    value = "10000"
  }
  tags = var.tags
}

resource "aws_db_instance" "primary" {
  identifier                            = local.name
  engine                                = "postgres"
  engine_version                        = "17"
  instance_class                        = var.instance_class
  allocated_storage                     = var.allocated_storage
  max_allocated_storage                 = var.max_allocated_storage
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = var.kms_key_arn
  db_name                               = "marketplace"
  username                              = "marketplace_admin"
  manage_master_user_password           = true # RDS-managed secret with rotation; never in tfvars/state
  db_subnet_group_name                  = aws_db_subnet_group.this.name
  vpc_security_group_ids                = [aws_security_group.db.id]
  parameter_group_name                  = aws_db_parameter_group.this.name
  publicly_accessible                   = false
  multi_az                              = var.multi_az
  backup_retention_period               = local.prod ? 14 : 1
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  auto_minor_version_upgrade            = true
  # Terraform's `prevent_destroy` can't depend on a variable; these are the per-env equivalents.
  deletion_protection       = local.prod
  skip_final_snapshot       = !local.prod
  final_snapshot_identifier = local.prod ? "${local.name}-final" : null
  copy_tags_to_snapshot     = true
  tags                      = var.tags
}

resource "aws_db_instance" "replica" {
  count                        = var.read_replica ? 1 : 0
  identifier                   = "${local.name}-replica"
  replicate_source_db          = aws_db_instance.primary.identifier
  instance_class               = var.instance_class
  storage_encrypted            = true
  kms_key_id                   = var.kms_key_arn
  vpc_security_group_ids       = [aws_security_group.db.id]
  parameter_group_name         = aws_db_parameter_group.this.name
  publicly_accessible          = false
  performance_insights_enabled = true
  skip_final_snapshot          = true
  tags                         = var.tags
}

# --- RDS Proxy ---
data "aws_iam_policy_document" "proxy_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  count              = var.rds_proxy ? 1 : 0
  name               = "${local.name}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "proxy" {
  count = var.rds_proxy ? 1 : 0
  role  = aws_iam_role.proxy[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_db_instance.primary.master_user_secret[0].secret_arn }]
  })
}

resource "aws_db_proxy" "this" {
  count                  = var.rds_proxy ? 1 : 0
  name                   = local.name
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy[0].arn
  vpc_subnet_ids         = var.subnet_ids
  vpc_security_group_ids = [aws_security_group.db.id]
  require_tls            = true
  idle_client_timeout    = 1800
  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_db_instance.primary.master_user_secret[0].secret_arn
  }
  tags = var.tags
}

resource "aws_db_proxy_default_target_group" "this" {
  count         = var.rds_proxy ? 1 : 0
  db_proxy_name = aws_db_proxy.this[0].name
  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 30
  }
}

resource "aws_db_proxy_target" "this" {
  count                  = var.rds_proxy ? 1 : 0
  db_proxy_name          = aws_db_proxy.this[0].name
  target_group_name      = aws_db_proxy_default_target_group.this[0].name
  db_instance_identifier = aws_db_instance.primary.identifier
}

output "endpoint" { value = var.rds_proxy ? aws_db_proxy.this[0].endpoint : aws_db_instance.primary.address }
output "read_endpoint" { value = var.read_replica ? aws_db_instance.replica[0].address : aws_db_instance.primary.address }
output "instance_id" { value = aws_db_instance.primary.identifier }
output "security_group_id" { value = aws_security_group.db.id }
output "master_secret_arn" { value = aws_db_instance.primary.master_user_secret[0].secret_arn }
