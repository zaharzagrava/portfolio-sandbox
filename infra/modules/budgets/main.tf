# Cost guardrails: a monthly budget with forecast + actual alerts, plus one per big-ticket service.
variable "env" { type = string }
variable "monthly_limit_usd" { type = number }
variable "emails" { type = list(string) }

resource "aws_budgets_budget" "total" {
  name         = "marketplace-${var.env}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:env$%s", var.env)]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.emails
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.emails
  }
}

# NAT data processing is the classic surprise: alert on it separately.
resource "aws_budgets_budget" "nat" {
  name         = "marketplace-${var.env}-nat"
  budget_type  = "USAGE"
  limit_amount = "500"
  limit_unit   = "GB"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "UsageType"
    values = ["EUC1-NatGateway-Bytes"]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.emails
  }
}
