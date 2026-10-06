# SQS → Lambda workers (SD-03), one per entry of the build's manifest.json (apps/lambdas/src/lambdas.manifest.ts).
# The event source mapping points at the `live` alias, which deploy.yml moves with a CodeDeploy canary
# (10% for 5 min, rollback on the function's alarms). maximum_concurrency caps containers → DB connections
# and provider token budgets; ReportBatchItemFailures = only failed records are retried.

variable "env" { type = string }
variable "functions" {
  description = "From manifest.json: name => { queue, timeoutSec, memoryMb, batchSize, maxConcurrency }"
  type = map(object({
    queue          = string
    timeoutSec     = number
    memoryMb       = number
    batchSize      = number
    maxConcurrency = number
  }))
}
variable "queue_arns" { type = map(string) }
variable "subnet_ids" { type = list(string) }
variable "security_group_ids" { type = list(string) }
variable "secret_arn" { type = string }
variable "kms_key_arns" { type = list(string) }
variable "extra_policy_json" {
  type    = string
  default = null
}
variable "alarm_topic_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
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

resource "aws_iam_role" "fn" {
  name               = "marketplace-${var.env}-lambda-workers"
  assume_role_policy = data.aws_iam_policy_document.trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "vpc" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "fn" {
  role = aws_iam_role.fn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"], Resource = [for f in var.functions : var.queue_arns[f.queue]] },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.secret_arn },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arns },
    ]
  })
}

resource "aws_iam_role_policy" "extra" {
  count  = var.extra_policy_json == null ? 0 : 1
  role   = aws_iam_role.fn.id
  policy = var.extra_policy_json
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
  role          = aws_iam_role.fn.arn
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
  event_source_arn                   = var.queue_arns[each.value.queue]
  function_name                      = aws_lambda_alias.live[each.key].arn
  batch_size                         = each.value.batchSize
  maximum_batching_window_in_seconds = 1
  function_response_types            = ["ReportBatchItemFailures"]
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
output "role_arn" { value = aws_iam_role.fn.arn }
