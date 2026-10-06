variable "env" { type = string }
variable "app" {
  description = "core | worker | projector | sse-gateway | payment-processor | collab | public-api | bff"
  type        = string
}
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "instance_types" {
  description = "First = preferred; more types widen Spot capacity pools."
  type        = list(string)
}
variable "min_size" { type = number }
variable "max_size" { type = number }
variable "desired_capacity" { type = number }
variable "on_demand_base" {
  description = "Instances always On-Demand; the rest Spot (workers/projectors tolerate interruption, APIs keep a base)."
  type        = number
  default     = 1
}
variable "spot_percentage_above_base" {
  type    = number
  default = 0
}
variable "ecr_repository_url" { type = string }
variable "artifacts_bucket" { type = string }
variable "secret_arn" { type = string }
variable "kms_key_arn" { type = string }
variable "target_group_arn" {
  description = "null for workers (no traffic)"
  type        = string
  default     = null
}
variable "target_group_name" {
  type    = string
  default = null
}
variable "listener_arn" {
  type    = string
  default = null
}
variable "alb_security_group_id" {
  type    = string
  default = null
}
variable "app_port" {
  type    = number
  default = 8000
}
variable "scaling" {
  description = "Target tracking: cpu (APIs) or a custom metric (projector: consumer lag, worker: queue depth)."
  type = object({
    cpu_target    = optional(number)
    metric_name   = optional(string)
    metric_ns     = optional(string)
    metric_target = optional(number)
  })
  default = { cpu_target = 55 }
}
variable "extra_policy_json" {
  description = "App-specific permissions (SQS queues, DynamoDB tables, S3 buckets, Keyspaces)."
  type        = string
  default     = null
}
variable "alarm_arns" {
  description = "Alarms that roll back a CodeDeploy deployment / an instance refresh."
  type        = list(string)
  default     = []
}
variable "alarm_names" {
  type    = list(string)
  default = []
}
variable "tags" {
  type    = map(string)
  default = {}
}
variable "amp_remote_write_url" {
  description = "Amazon Managed Prometheus remote-write URL; empty = metrics stay local (demo)."
  type        = string
  default     = ""
}
variable "trace_sampling_percent" {
  type    = number
  default = 10
}
