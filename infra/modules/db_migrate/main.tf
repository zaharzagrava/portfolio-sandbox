# Release migrations run INSIDE the VPC as a CodeBuild project using the `migrator` image (O-02):
# Postgres (sequelize-cli), then CQL on Keyspaces. deploy.yml starts it and waits before any app rolls out.
variable "env" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "migrator_repository_url" { type = string }
variable "migrator_repository_arn" { type = string }
variable "secret_arn" { type = string }
variable "kms_key_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

locals { name = "marketplace-${var.env}-db-migrate" }

resource "aws_security_group" "this" {
  name   = local.name
  vpc_id = var.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = var.tags
}

resource "aws_iam_role" "this" {
  name = local.name
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "codebuild.amazonaws.com" } }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "this" {
  role = aws_iam_role.this.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = var.migrator_repository_arn },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.secret_arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
      {
        Effect   = "Allow"
        Action   = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeDhcpOptions", "ec2:DescribeVpcs", "ec2:CreateNetworkInterfacePermission"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_codebuild_project" "this" {
  name          = local.name
  service_role  = aws_iam_role.this.arn
  build_timeout = 30
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    type                        = "ARM_CONTAINER"
    image                       = "${var.migrator_repository_url}:bootstrap" # deploy.yml overrides per release (--image-override)
    image_pull_credentials_type = "SERVICE_ROLE"
    # Secrets resolved by CodeBuild itself (no AWS CLI needed in the image, nothing echoed to logs).
    dynamic "environment_variable" {
      for_each = toset(["DB_HOST", "DB_PORT", "DB_USERNAME", "DB_PASSWORD", "DB_NAME", "CASSANDRA_CONTACT_POINTS", "CASSANDRA_LOCAL_DC", "CASSANDRA_KEYSPACE", "CASSANDRA_USERNAME", "CASSANDRA_PASSWORD"])
      content {
        name  = environment_variable.value
        type  = "SECRETS_MANAGER"
        value = "marketplace/${var.env}/app:${environment_variable.value}"
      }
    }
  }
  source {
    type      = "NO_SOURCE"
    buildspec = <<-YAML
      version: 0.2
      phases:
        build:
          commands:
            - cd /repo/packages/backend && sequelize-cli db:migrate --env production
            - cd /repo/packages/backend && pnpm cql:migrate
    YAML
  }
  vpc_config {
    vpc_id             = var.vpc_id
    subnets            = var.subnet_ids
    security_group_ids = [aws_security_group.this.id]
  }
  tags = var.tags
}

output "project_name" { value = aws_codebuild_project.this.name }
output "security_group_id" { value = aws_security_group.this.id }
