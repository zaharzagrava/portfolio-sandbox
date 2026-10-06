# VPC across 2 AZs: public (ALB, NAT), private (apps), data (RDS, ElastiCache, search) subnets.
# NAT is the classic surprise bill: demo uses ONE gateway, prod one per AZ; gateway endpoints
# for S3/DynamoDB are free and take the bulk of traffic off NAT; interface endpoints only in prod.

variable "name" { type = string }
variable "cidr" {
  type    = string
  default = "10.20.0.0/16"
}
variable "azs" { type = list(string) }
variable "nat_per_az" {
  type    = bool
  default = false
}
variable "interface_endpoints" {
  description = "Interface endpoints (SQS, ECR, Secrets Manager, SSM, Logs) - ~$7/month each per AZ, worth it once NAT data charges exceed that."
  type        = bool
  default     = false
}
variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_region" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = merge(var.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = var.name })
}

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.azs[count.index]
  cidr_block              = cidrsubnet(var.cidr, 8, count.index)
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-public-${var.azs[count.index]}", tier = "public" })
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = var.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 4, count.index + 1)
  tags              = merge(var.tags, { Name = "${var.name}-private-${var.azs[count.index]}", tier = "private" })
}

resource "aws_subnet" "data" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = var.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 8, 200 + count.index)
  tags              = merge(var.tags, { Name = "${var.name}-data-${var.azs[count.index]}", tier = "data" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

locals {
  nat_count = var.nat_per_az ? length(var.azs) : 1
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(var.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_route_table" "private" {
  count  = length(var.azs)
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.nat_per_az ? count.index : 0].id
  }
  tags = merge(var.tags, { Name = "${var.name}-private-${var.azs[count.index]}" })
}

resource "aws_route_table_association" "private" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Data subnets: no internet route at all.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-data" })
}

resource "aws_route_table_association" "data" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

resource "aws_vpc_endpoint" "gateway" {
  for_each          = toset(["s3", "dynamodb"])
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.private[*].id, [aws_route_table.data.id])
  tags              = merge(var.tags, { Name = "${var.name}-${each.key}" })
}

resource "aws_security_group" "endpoints" {
  count  = var.interface_endpoints ? 1 : 0
  name   = "${var.name}-vpc-endpoints"
  vpc_id = aws_vpc.this.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr]
  }
  tags = var.tags
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = var.interface_endpoints ? toset(["sqs", "ecr.api", "ecr.dkr", "secretsmanager", "ssm", "logs", "sts"]) : toset([])
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  tags                = merge(var.tags, { Name = "${var.name}-${each.key}" })
}

output "vpc_id" { value = aws_vpc.this.id }
output "vpc_cidr" { value = aws_vpc.this.cidr_block }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "data_subnet_ids" { value = aws_subnet.data[*].id }
