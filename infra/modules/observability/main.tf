# AWS side of SD-33/O-01: the alarms that GATE deployments (CodeDeploy / instance refresh roll back on them),
# DLQ alarms (CloudWatch's view of DLQNotEmpty), Amazon Managed Prometheus for the generated SLO rules,
# and the paging topic Alertmanager-equivalents publish to.

variable "env" { type = string }
variable "alb_arn_suffix" { type = string }
variable "target_group_arn_suffixes" { type = map(string) }
variable "dlq_names" { type = map(string) }
variable "asg_names" {
  description = "app => ASG name for apps without a target group (workers)"
  type        = map(string)
}
variable "pager_email" {
  type    = string
  default = null
}
variable "managed_prometheus" {
  type    = bool
  default = false
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals { name = "marketplace-${var.env}" }

resource "aws_sns_topic" "pager" {
  name = "${local.name}-pager"
  tags = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.pager_email == null ? 0 : 1
  topic_arn = aws_sns_topic.pager.arn
  protocol  = "email"
  endpoint  = var.pager_email
}

# Per HTTP service: 5xx ratio and p99 - the deployment rollback triggers.
resource "aws_cloudwatch_metric_alarm" "service_5xx" {
  for_each            = var.target_group_arn_suffixes
  alarm_name          = "${local.name}-${each.key}-errors"
  alarm_description   = "5xx ratio > 2% for 3 minutes (rolls back CodeDeploy)"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.02
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.pager.arn]

  metric_query {
    id          = "ratio"
    expression  = "errors / MAX([errors, requests])"
    label       = "5xx ratio"
    return_data = true
  }
  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
      period      = 60
      stat        = "Sum"
    }
  }
  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
      period      = 60
      stat        = "Sum"
    }
  }
  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "service_p99" {
  for_each            = { for k, v in var.target_group_arn_suffixes : k => v if k != "sse-gateway" && k != "collab" } # streams are long by design
  alarm_name          = "${local.name}-${each.key}-p99"
  alarm_description   = "p99 target response time > 1.5 s for 5 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = each.value }
  extended_statistic  = "p99"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1.5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.pager.arn]
  tags                = var.tags
}

# Workers: instance-refresh rollback trigger = instances failing EC2 status checks after the new launch template.
resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  for_each            = var.asg_names
  alarm_name          = "${local.name}-${each.key}-errors"
  alarm_description   = "Instances of ${each.key} failing status checks"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { AutoScalingGroupName = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.pager.arn]
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "dlq" {
  for_each            = var.dlq_names
  alarm_name          = "${local.name}-dlq-${each.key}"
  alarm_description   = "DLQ not empty - runbook docs/runbooks/DLQNotEmpty.md"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.pager.arn]
  tags                = var.tags
}

resource "aws_prometheus_workspace" "this" {
  count = var.managed_prometheus ? 1 : 0
  alias = local.name
  tags  = var.tags
}

# The same files Prometheus loads locally (generated SLO rules + cause alerts), uploaded unchanged.
resource "aws_prometheus_rule_group_namespace" "rules" {
  for_each     = var.managed_prometheus ? toset(["causes.yml", "slo.generated.yml"]) : toset([])
  name         = trimsuffix(each.key, ".yml")
  workspace_id = aws_prometheus_workspace.this[0].id
  data         = file("${path.module}/../../observability/prometheus/rules/${each.key}")
}

output "pager_topic_arn" { value = aws_sns_topic.pager.arn }
output "alarm_names" {
  value = merge(
    { for k, a in aws_cloudwatch_metric_alarm.service_5xx : k => [a.alarm_name] },
    { for k, a in aws_cloudwatch_metric_alarm.worker_errors : k => [a.alarm_name] },
  )
}
output "amp_remote_write_url" { value = var.managed_prometheus ? "${aws_prometheus_workspace.this[0].prometheus_endpoint}api/v1/remote_write" : "" }
