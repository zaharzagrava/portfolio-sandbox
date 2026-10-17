# SQS → Lambda workers (SD-03), one per entry of the build's manifest.json
# (packages/backend/libs/infrastructure/serverless/manifest/lambdas.manifest.ts, S55). A dead-letter handler is its own
# element of the manifest (`deadLetterOf`) and consumes the dead-letter queue of its source queue.
# The event source mapping points at the `live` alias, which deploy.yml moves with a CodeDeploy canary
# (10% for 5 min, rollback on the function's alarms). maximum_concurrency caps containers → DB connections
# and provider token budgets; ReportBatchItemFailures = only failed records are retried.

variable "env" { type = string }
variable "functions" {
  description = "From manifest.json: name => the entry (queue, limits, deadLetterOf for a dead-letter handler)"
  type = map(object({
    queue                = string
    timeoutSec           = number
    memoryMb             = number
    batchSize            = number
    maxConcurrency       = number
    visibilityTimeoutSec = optional(number)
    maxReceiveCount      = optional(number)
    fifo                 = optional(bool, false)
    dbPoolMax            = optional(number, 2)
    deadLetterOf         = optional(string)
  }))
}
variable "queue_arns" { type = map(string) }
variable "queue_names" { type = map(string) }
variable "dlq_arns" {
  description = "Dead-letter queue ARN per source queue key; a dead-letter handler consumes it"
  type        = map(string)
}
variable "dlq_names" { type = map(string) }
variable "idempotency_table_arn" { type = string }
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "secret_arn" { type = string }
variable "kms_key_arns" { type = list(string) }
variable "extra_policy_json" {
  description = "function name => policy JSON for rights that are not queue, table, secret or key (S3 for media-processing)"
  type        = map(string)
  default     = {}
}
variable "alarm_topic_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  # The queue a function consumes: its own, or (a dead-letter handler) the dead-letter queue of its source's queue.
  consumed_queue_arn = {
    for k, f in var.functions : k => f.deadLetterOf == null ? var.queue_arns[f.queue] : var.dlq_arns[var.functions[f.deadLetterOf].queue]
  }
  consumed_queue_name = {
    for k, f in var.functions : k => f.deadLetterOf == null ? var.queue_names[f.queue] : var.dlq_names[var.functions[f.deadLetterOf].queue]
  }
  source_functions = { for k, f in var.functions : k => f if f.deadLetterOf == null }
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# One execution role per function (S55 FR-048): least privilege, a blast radius of one function.
resource "aws_iam_role" "fn" {
  for_each           = var.functions
  name               = "marketplace-${var.env}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "vpc" {
  for_each   = var.functions
  role       = aws_iam_role.fn[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "fn" {
  for_each = var.functions
  role     = aws_iam_role.fn[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"], Resource = [local.consumed_queue_arn[each.key]] },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource = [var.idempotency_table_arn] },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.secret_arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arns },
    ]
  })
}

resource "aws_iam_role_policy" "extra" {
  for_each = { for k, v in var.extra_policy_json : k => v if contains(keys(var.functions), k) }
  role     = aws_iam_role.fn[each.key].id
  policy   = each.value
}

data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/.placeholder.zip"
  source {
    content  = "exports.handler = async () => ({ batchItemFailures: [] });"
    filename = "index.js"
  }
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = var.functions
  name              = "/aws/lambda/marketplace-${var.env}-${each.key}"
  retention_in_days = var.env == "prod" ? 30 : 7
  tags              = var.tags
}

resource "aws_lambda_function" "this" {
  for_each      = var.functions
  function_name = "marketplace-${var.env}-${each.key}"
  role          = aws_iam_role.fn[each.key].arn
  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  timeout       = each.value.timeoutSec
  memory_size   = each.value.memoryMb
  # Code is deployed by deploy.yml (update-function-code + publish + canary); Terraform only creates the shell.
  filename = data.archive_file.placeholder.output_path
  publish  = true
  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = var.security_group_ids
  }
  environment {
    variables = {
      NODE_ENV      = "production"
      AWS_SECRET_ID = "marketplace/${var.env}/app"
      NODE_OPTIONS  = "--enable-source-maps"
      DB_POOL_MAX   = tostring(each.value.dbPoolMax) # concurrency × pool is the connection budget (manifest)
    }
  }
  tracing_config { mode = "Active" }
  depends_on = [aws_cloudwatch_log_group.fn]
  lifecycle { ignore_changes = [filename, source_code_hash] }
  tags = var.tags
}

resource "aws_lambda_alias" "live" {
  for_each         = var.functions
  name             = "live"
  function_name    = aws_lambda_function.this[each.key].function_name
  function_version = aws_lambda_function.this[each.key].version
  lifecycle { ignore_changes = [function_version, routing_config] }
}

resource "aws_lambda_event_source_mapping" "sqs" {
  for_each                           = var.functions
  event_source_arn                   = local.consumed_queue_arn[each.key]
  function_name                      = aws_lambda_alias.live[each.key].arn
  batch_size                         = each.value.batchSize
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]
  # Connection arithmetic (constitution III.12): every container holds at most `dbPoolMax` connections, so the database
  # sees concurrency × pool from each function. The sum over all functions (dead-letter handlers included) is validated
  # against the connection budget by the manifest (validateManifest, S55 AS-30); change `maxConcurrency` there.
  scaling_config { maximum_concurrency = max(2, each.value.maxConcurrency) }
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each            = var.functions
  alarm_name          = "marketplace-${var.env}-${each.key}-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.this[each.key].function_name, Resource = "${aws_lambda_function.this[each.key].function_name}:live" }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  tags                = var.tags
}

# A message in a dead-letter queue pages an operator (S55 SC-003); the dead-letter handler normally drains it.
resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  for_each            = local.source_functions
  alarm_name          = "marketplace-${var.env}-${each.key}-dlq-depth"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = var.dlq_names[each.value.queue] }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  tags                = var.tags
}

# The oldest message of a consumed queue should never be older than a few function timeouts.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each            = var.functions
  alarm_name          = "marketplace-${var.env}-${each.key}-queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = local.consumed_queue_name[each.key] }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = max(300, 10 * each.value.timeoutSec)
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "throttles" {
  for_each            = var.functions
  alarm_name          = "marketplace-${var.env}-${each.key}-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.this[each.key].function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  tags                = var.tags
}

# --- Canary deployments of the `live` alias ---
resource "aws_codedeploy_app" "lambda" {
  name             = "marketplace-${var.env}-lambda"
  compute_platform = "Lambda"
  tags             = var.tags
}

data "aws_iam_policy_document" "codedeploy_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codedeploy.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codedeploy" {
  name               = "marketplace-${var.env}-lambda-codedeploy"
  assume_role_policy = data.aws_iam_policy_document.codedeploy_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  role       = aws_iam_role.codedeploy.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda"
}

resource "aws_codedeploy_deployment_group" "fn" {
  for_each               = var.functions
  app_name               = aws_codedeploy_app.lambda.name
  deployment_group_name  = each.key
  service_role_arn       = aws_iam_role.codedeploy.arn
  deployment_config_name = var.env == "prod" ? "CodeDeployDefault.LambdaCanary10Percent5Minutes" : "CodeDeployDefault.LambdaAllAtOnce"
  deployment_style {
    deployment_option = "WITH_TRAFFIC_CONTROL"
    deployment_type   = "BLUE_GREEN"
  }
  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }
  alarm_configuration {
    enabled = true
    alarms  = [aws_cloudwatch_metric_alarm.errors[each.key].alarm_name]
  }
}

output "function_names" { value = { for k, f in aws_lambda_function.this : k => f.function_name } }
output "role_arns" { value = { for k, r in aws_iam_role.fn : k => r.arn } }
