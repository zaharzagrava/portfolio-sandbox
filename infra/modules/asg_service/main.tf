# One app = one ASG of EC2 instances running one container (no Kubernetes, D10-D16).
#  - user-data: Docker + CodeDeploy agent + ADOT collector; on first boot it renders release.env from SSM
#    (/marketplace/<env>/<app>/image_tag) and runs the same hooks CodeDeploy runs, so a scale-out boots the
#    currently deployed version without a deployment.
#  - APIs: blue/green CodeDeploy deployment group behind their target group.
#  - Workers: instance refresh (deploy.yml); termination lifecycle hook gives in-flight work time to finish.

locals {
  name = "marketplace-${var.env}-${var.app}"
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

resource "aws_ssm_parameter" "image_tag" {
  name  = "/marketplace/${var.env}/${var.app}/image_tag"
  type  = "String"
  value = "bootstrap"
  # deploy.yml owns the value after the first apply.
  lifecycle { ignore_changes = [value] }
  tags = var.tags
}

resource "aws_security_group" "app" {
  name   = local.name
  vpc_id = var.vpc_id
  dynamic "ingress" {
    for_each = var.alb_security_group_id == null ? [] : [1]
    content {
      from_port       = var.app_port
      to_port         = var.app_port
      protocol        = "tcp"
      security_groups = [var.alb_security_group_id]
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(var.tags, { Name = local.name })
}

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore", # Session Manager instead of SSH
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
    "arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess",
    "arn:aws:iam::aws:policy/AmazonPrometheusRemoteWriteAccess",
  ])
  role       = aws_iam_role.instance.name
  policy_arn = each.value
}

resource "aws_iam_role_policy" "base" {
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.secret_arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = aws_ssm_parameter.image_tag.arn },
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = "arn:aws:s3:::${var.artifacts_bucket}/codedeploy/${var.env}/*" },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:*:*:log-group:/marketplace/${var.env}/${var.app}:*" },
      { Effect = "Allow", Action = ["autoscaling:CompleteLifecycleAction"], Resource = "arn:aws:autoscaling:*:*:autoScalingGroup:*:autoScalingGroupName/${local.name}" },
    ]
  })
}

resource "aws_iam_role_policy" "extra" {
  count  = var.extra_policy_json == null ? 0 : 1
  role   = aws_iam_role.instance.id
  policy = var.extra_policy_json
}

resource "aws_iam_instance_profile" "this" {
  name = local.name
  role = aws_iam_role.instance.name
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/marketplace/${var.env}/${var.app}"
  retention_in_days = var.env == "prod" ? 30 : 7
  tags              = var.tags
}

resource "aws_launch_template" "this" {
  name_prefix   = "${local.name}-"
  image_id      = data.aws_ssm_parameter.al2023.value
  instance_type = var.instance_types[0]
  iam_instance_profile { arn = aws_iam_instance_profile.this.arn }
  vpc_security_group_ids = [aws_security_group.app.id]
  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 2          # the container reaches IMDS through the docker bridge
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
  monitoring { enabled = true }
  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    env                    = var.env
    app                    = var.app
    region                 = data.aws_region.current.name
    repository_url         = var.ecr_repository_url
    artifacts_bucket       = var.artifacts_bucket
    asg_name               = local.name
    amp_remote_write_url   = var.amp_remote_write_url
    trace_sampling_percent = var.trace_sampling_percent
  }))
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = local.name, service = var.app })
  }
  tags = var.tags
}

resource "aws_autoscaling_group" "this" {
  name                      = local.name
  vpc_zone_identifier       = var.subnet_ids
  min_size                  = var.min_size
  max_size                  = var.max_size
  desired_capacity          = var.desired_capacity
  health_check_type         = var.target_group_arn == null ? "EC2" : "ELB"
  health_check_grace_period = 120
  target_group_arns         = var.target_group_arn == null ? [] : [var.target_group_arn]
  default_instance_warmup   = 60
  capacity_rebalance        = true

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = var.on_demand_base
      on_demand_percentage_above_base_capacity = 100 - var.spot_percentage_above_base
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.this.id
        version            = "$Latest"
      }
      dynamic "override" {
        for_each = var.instance_types
        content { instance_type = override.value }
      }
    }
  }

  # Graceful scale-in: the instance waits (up to 5 min) while the app drains (F-01 shutdown) - the user-data
  # termination watcher stops the container and completes the lifecycle action.
  initial_lifecycle_hook {
    name                 = "drain"
    lifecycle_transition = "autoscaling:EC2_INSTANCE_TERMINATING"
    heartbeat_timeout    = 300
    default_result       = "CONTINUE"
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 90
      instance_warmup        = 60
      auto_rollback          = true
    }
  }

  dynamic "tag" {
    for_each = merge(var.tags, { Name = local.name, service = var.app })
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  # CodeDeploy blue/green replaces the group; Terraform must not fight over capacity afterwards.
  lifecycle { ignore_changes = [desired_capacity, target_group_arns] }
}

resource "aws_autoscaling_policy" "cpu" {
  count                  = var.scaling.cpu_target == null ? 0 : 1
  name                   = "${local.name}-cpu"
  autoscaling_group_name = aws_autoscaling_group.this.name
  policy_type            = "TargetTrackingScaling"
  target_tracking_configuration {
    predefined_metric_specification { predefined_metric_type = "ASGAverageCPUUtilization" }
    target_value = var.scaling.cpu_target
  }
}

resource "aws_autoscaling_policy" "custom" {
  count                  = var.scaling.metric_name == null ? 0 : 1
  name                   = "${local.name}-${var.scaling.metric_name}"
  autoscaling_group_name = aws_autoscaling_group.this.name
  policy_type            = "TargetTrackingScaling"
  target_tracking_configuration {
    customized_metric_specification {
      metric_name = var.scaling.metric_name
      namespace   = var.scaling.metric_ns
      statistic   = "Average"
      metric_dimension {
        name  = "AutoScalingGroupName"
        value = aws_autoscaling_group.this.name
      }
    }
    target_value = var.scaling.metric_target
  }
}

# --- Blue/green for HTTP services ---
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
  count              = var.target_group_arn == null ? 0 : 1
  name               = "${local.name}-codedeploy"
  assume_role_policy = data.aws_iam_policy_document.codedeploy_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  count      = var.target_group_arn == null ? 0 : 1
  role       = aws_iam_role.codedeploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRole"
}

resource "aws_codedeploy_deployment_group" "this" {
  count                  = var.target_group_arn == null ? 0 : 1
  app_name               = "marketplace-${var.env}"
  deployment_group_name  = var.app
  service_role_arn       = aws_iam_role.codedeploy[0].arn
  deployment_config_name = "CodeDeployDefault.AllAtOnce" # blue/green: the whole green fleet must pass validate.sh before traffic moves
  autoscaling_groups     = [aws_autoscaling_group.this.name]

  deployment_style {
    deployment_option = "WITH_TRAFFIC_CONTROL"
    deployment_type   = "BLUE_GREEN"
  }

  blue_green_deployment_config {
    deployment_ready_option { action_on_timeout = "CONTINUE_DEPLOYMENT" }
    green_fleet_provisioning_option { action = "COPY_AUTO_SCALING_GROUP" }
    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = 15 # quick manual rollback window: blue is still there
    }
  }

  load_balancer_info {
    target_group_info { name = var.target_group_name }
  }

  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }

  dynamic "alarm_configuration" {
    for_each = length(var.alarm_names) > 0 ? [1] : []
    content {
      enabled = true
      alarms  = var.alarm_names
    }
  }
}

output "asg_name" { value = aws_autoscaling_group.this.name }
output "security_group_id" { value = aws_security_group.app.id }
output "instance_role_arn" { value = aws_iam_role.instance.arn }
output "instance_role_name" { value = aws_iam_role.instance.name }
