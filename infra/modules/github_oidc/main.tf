# GitHub Actions → AWS without static keys. Two roles, least privilege:
#  build  (any branch of the repo): push images, upload artifacts
#  deploy (master + the protected `prod`/`demo` environments only): CodeDeploy, CodeBuild, SSM, ASG refresh, Lambda
variable "env" { type = string }
variable "github_repo" {
  description = "owner/name"
  type        = string
}
variable "create_provider" {
  description = "The OIDC provider is account-wide: create it in one env only."
  type        = bool
  default     = false
}
variable "ecr_repository_arns" { type = list(string) }
variable "artifacts_bucket_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  tags           = var.tags
}

locals {
  provider_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "build_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only jobs running in the protected GitHub environment of THIS env can deploy (prod = required reviewers).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:environment:${var.env}"]
    }
  }
}

resource "aws_iam_role" "build" {
  name               = "marketplace-${var.env}-gha-build"
  assume_role_policy = data.aws_iam_policy_document.build_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "build" {
  role = aws_iam_role.build.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage"]
        Resource = var.ecr_repository_arns
      },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${var.artifacts_bucket_arn}/lambdas/*" },
    ]
  })
}

resource "aws_iam_role" "deploy" {
  name               = "marketplace-${var.env}-gha-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = ["${var.artifacts_bucket_arn}/codedeploy/${var.env}/*", "${var.artifacts_bucket_arn}/lambdas/*"] },
      { Effect = "Allow", Action = ["codedeploy:CreateDeployment", "codedeploy:GetDeployment", "codedeploy:GetDeploymentConfig", "codedeploy:RegisterApplicationRevision", "codedeploy:GetApplicationRevision"], Resource = "*" },
      { Effect = "Allow", Action = ["codebuild:StartBuild", "codebuild:BatchGetBuilds"], Resource = "arn:aws:codebuild:*:${data.aws_caller_identity.current.account_id}:project/marketplace-${var.env}-*" },
      { Effect = "Allow", Action = ["ssm:PutParameter"], Resource = "arn:aws:ssm:*:${data.aws_caller_identity.current.account_id}:parameter/marketplace/${var.env}/*" },
      { Effect = "Allow", Action = ["autoscaling:StartInstanceRefresh", "autoscaling:DescribeInstanceRefreshes"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["lambda:UpdateFunctionCode", "lambda:PublishVersion", "lambda:GetAlias", "lambda:GetFunction", "lambda:GetFunctionConfiguration"]
        Resource = "arn:aws:lambda:*:${data.aws_caller_identity.current.account_id}:function:marketplace-${var.env}-*"
      },
    ]
  })
}

output "build_role_arn" { value = aws_iam_role.build.arn }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
