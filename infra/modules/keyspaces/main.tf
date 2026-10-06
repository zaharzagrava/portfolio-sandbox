# Amazon Keyspaces = the managed Cassandra-compatible store for the Scylla workloads (D24: feeds, inbox,
# discussions, assistant transcripts). Terraform owns the keyspace and access; TABLES come from the same
# packages/backend/cql/*.cql files used locally, applied by `pnpm cql:migrate` in the release's migration step
# (Keyspaces accepts CREATE TABLE over CQL) - one schema source, no drift between Scylla and Keyspaces.
#
# Driver auth: service-specific credentials of the IAM user below (PlainTextAuthProvider + TLS, LOCAL_QUORUM).
# Create them out-of-band (`aws iam create-service-specific-credential --service-name cassandra.amazonaws.com`)
# and put them in the app secret - never in Terraform state.

variable "env" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

resource "aws_keyspaces_keyspace" "this" {
  name = "marketplace_${var.env}"
  tags = var.tags
}

resource "aws_iam_user" "app" {
  name = "marketplace-${var.env}-keyspaces"
  tags = var.tags
}

resource "aws_iam_user_policy" "app" {
  user = aws_iam_user.app.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["cassandra:Select", "cassandra:Modify", "cassandra:Create", "cassandra:Alter"]
        Resource = [
          "arn:aws:cassandra:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:/keyspace/${aws_keyspaces_keyspace.this.name}/",
          "arn:aws:cassandra:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:/keyspace/${aws_keyspaces_keyspace.this.name}/table/*",
          # The driver reads system tables for topology/peers.
          "arn:aws:cassandra:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:/keyspace/system*",
        ]
      },
    ]
  })
}

output "keyspace" { value = aws_keyspaces_keyspace.this.name }
output "contact_point" { value = "cassandra.${data.aws_region.current.name}.amazonaws.com:9142" }
