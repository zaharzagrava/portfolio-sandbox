# Secret CONTAINERS only. Values are put out-of-band (console / `aws secretsmanager put-secret-value`),
# never in tfvars or state. The app reads `marketplace/<env>/app` at boot (AWS_SECRET_ID).
variable "env" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_kms_key" "secrets" {
  description         = "marketplace-${var.env} secrets"
  enable_key_rotation = true
  tags                = var.tags
}

resource "aws_secretsmanager_secret" "this" {
  for_each = {
    app = "Runtime config for every Nest app: PORT=8000, DB_*, REDIS_URL, KAFKA_*, STRIPE_*, ANTHROPIC_API_KEY, VOYAGE_API_KEY, AUTH_KEK, ..."
    db  = "RDS master credentials (rotated by RDS; apps use a least-privilege role from `app`)"
  }
  name        = "marketplace/${var.env}/${each.key}"
  description = each.value
  kms_key_id  = aws_kms_key.secrets.arn
  tags        = var.tags
}

output "secret_arns" { value = { for k, s in aws_secretsmanager_secret.this : k => s.arn } }
output "kms_key_arn" { value = aws_kms_key.secrets.arn }
