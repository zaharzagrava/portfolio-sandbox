# Task queues (D18): every queue has a DLQ (redrive after max_receive) - the same list as
# infra/docker/elasticmq/elasticmq.conf, which mirrors it locally. Lambda-consumed queues need
# visibility ≥ 6 × function timeout (the lambda manifest sets both).

variable "env" { type = string }
variable "queues" {
  type = map(object({
    visibility_seconds = number
    max_receive        = number
    fifo               = optional(bool, false)
  }))
}
variable "kms_key_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  # Map keys are the logical names the app uses ("webhook-deliveries.fifo" keeps its suffix).
  base = { for k, v in var.queues : k => trimsuffix(k, ".fifo") }
}

resource "aws_sqs_queue" "dlq" {
  for_each                  = var.queues
  name                      = each.value.fifo ? "${var.env}-${local.base[each.key]}-dlq.fifo" : "${var.env}-${each.key}-dlq"
  fifo_queue                = each.value.fifo
  message_retention_seconds = 1209600 # 14 days to investigate and redrive
  kms_master_key_id         = var.kms_key_arn
  tags                      = var.tags
}

resource "aws_sqs_queue" "this" {
  for_each                   = var.queues
  name                       = "${var.env}-${each.key}"
  fifo_queue                 = each.value.fifo
  visibility_timeout_seconds = each.value.visibility_seconds
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20 # long polling: fewer empty receives (cost)
  kms_master_key_id          = var.kms_key_arn
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = each.value.max_receive
  })
  tags = var.tags
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each  = var.queues
  queue_url = aws_sqs_queue.dlq[each.key].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.this[each.key].arn]
  })
}

output "queue_arns" { value = { for k, q in aws_sqs_queue.this : k => q.arn } }
output "queue_urls" { value = { for k, q in aws_sqs_queue.this : k => q.url } }
output "dlq_names" { value = { for k, q in aws_sqs_queue.dlq : k => q.name } }
output "all_arns" { value = concat([for q in aws_sqs_queue.this : q.arn], [for q in aws_sqs_queue.dlq : q.arn]) }
