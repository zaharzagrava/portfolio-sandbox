# Public ALB: TLS terminates here (ACM), Cloudflare in front (proxied DNS, WAF/DDoS at the edge).
# One target group per HTTP service, routed by path; health check = /health/ready (F-01 readiness).
# Long-lived streams (SSE, collab WebSockets) get a 1 h idle timeout.

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "certificate_arn" { type = string }
variable "services" {
  description = "service => { port, paths (listener rule), priority, stickiness, deregistration_delay }"
  type = map(object({
    port                 = number
    paths                = list(string)
    priority             = number
    deregistration_delay = optional(number, 30)
  }))
}
variable "default_service" {
  type    = string
  default = "core"
}
variable "allowed_ingress_cidrs" {
  description = "Cloudflare IP ranges in prod (origin only reachable through the edge); 0.0.0.0/0 in demo."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_security_group" "alb" {
  name   = "${var.name}-alb"
  vpc_id = var.vpc_id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_ingress_cidrs
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = var.tags
}

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  idle_timeout               = 3600
  drop_invalid_header_fields = true
  tags                       = var.tags
}

resource "aws_lb_target_group" "service" {
  for_each             = var.services
  name                 = substr("${var.name}-${each.key}", 0, 32)
  port                 = each.value.port
  protocol             = "HTTP"
  vpc_id               = var.vpc_id
  deregistration_delay = each.value.deregistration_delay
  health_check {
    path                = "/health/ready"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    matcher             = "200"
  }
  tags = var.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[var.default_service].arn
  }
}

resource "aws_lb_listener_rule" "service" {
  for_each     = { for k, v in var.services : k => v if length(v.paths) > 0 }
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[each.key].arn
  }
  condition {
    path_pattern { values = each.value.paths }
  }
}

output "alb_arn" { value = aws_lb.this.arn }
output "alb_arn_suffix" { value = aws_lb.this.arn_suffix }
output "dns_name" { value = aws_lb.this.dns_name }
output "security_group_id" { value = aws_security_group.alb.id }
output "listener_arn" { value = aws_lb_listener.https.arn }
output "target_group_arns" { value = { for k, tg in aws_lb_target_group.service : k => tg.arn } }
output "target_group_names" { value = { for k, tg in aws_lb_target_group.service : k => tg.name } }
output "target_group_arn_suffixes" { value = { for k, tg in aws_lb_target_group.service : k => tg.arn_suffix } }
