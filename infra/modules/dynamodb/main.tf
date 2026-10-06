# Tables are defined ONCE, in packages/backend/dynamodb/*.json (CreateTable input used by local dev/tests);
# this module reads the same files, so local and AWS schemas can't drift. On-demand billing (spiky, D25).

variable "env" { type = string }
variable "definitions_dir" {
  description = "Path to packages/backend/dynamodb"
  type        = string
}
variable "kms_key_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  tables = { for f in fileset(var.definitions_dir, "*.json") : trimsuffix(f, ".json") => jsondecode(file("${var.definitions_dir}/${f}")) }
}

resource "aws_dynamodb_table" "this" {
  for_each                    = local.tables
  name                        = "${var.env}_${each.value.TableName}"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = one([for k in each.value.KeySchema : k.AttributeName if k.KeyType == "HASH"])
  range_key                   = try(one([for k in each.value.KeySchema : k.AttributeName if k.KeyType == "RANGE"]), null)
  deletion_protection_enabled = var.env == "prod"

  dynamic "attribute" {
    for_each = each.value.AttributeDefinitions
    content {
      name = attribute.value.AttributeName
      type = attribute.value.AttributeType
    }
  }

  dynamic "global_secondary_index" {
    for_each = try(each.value.GlobalSecondaryIndexes, [])
    content {
      name               = global_secondary_index.value.IndexName
      hash_key           = one([for k in global_secondary_index.value.KeySchema : k.AttributeName if k.KeyType == "HASH"])
      range_key          = try(one([for k in global_secondary_index.value.KeySchema : k.AttributeName if k.KeyType == "RANGE"]), null)
      projection_type    = global_secondary_index.value.Projection.ProjectionType
      non_key_attributes = try(global_secondary_index.value.Projection.NonKeyAttributes, null)
    }
  }

  dynamic "ttl" {
    for_each = try(each.value.TimeToLiveAttribute, null) == null ? [] : [each.value.TimeToLiveAttribute]
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }

  point_in_time_recovery { enabled = var.env == "prod" }
  server_side_encryption {
    enabled     = true
    kms_key_arn = var.kms_key_arn
  }
  tags = var.tags
}

output "table_arns" { value = [for t in aws_dynamodb_table.this : t.arn] }
output "table_names" { value = { for k, t in aws_dynamodb_table.this : k => t.name } }
