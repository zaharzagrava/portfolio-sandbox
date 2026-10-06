# One repository per app (+ migrator). Immutable tags = commit SHAs; old images expire.
variable "repositories" { type = list(string) }
variable "keep_images" {
  type    = number
  default = 30
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_ecr_repository" "this" {
  for_each             = toset(var.repositories)
  name                 = "marketplace/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
  tags = var.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last ${var.keep_images} images (rollback window)"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = var.keep_images }
      action       = { type = "expire" }
    }]
  })
}

output "repository_urls" { value = { for k, r in aws_ecr_repository.this : k => r.repository_url } }
output "repository_arns" { value = [for r in aws_ecr_repository.this : r.arn] }
