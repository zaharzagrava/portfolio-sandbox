# Elasticsearch (search, SD-37) + ClickHouse (analytics/usage/LLM metrics).
#   demo: ONE t4g.medium running both in Docker on an encrypted gp3 volume (D16: smallest viable).
#   prod: Amazon OpenSearch Service (managed, multi-AZ, dedicated masters) + a ClickHouse EC2 node with its own
#         gp3 volume (ClickHouse Cloud is the alternative once ingestion outgrows one node - ADR in infra/README).

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "client_security_group_ids" { type = list(string) }
variable "mode" {
  description = "shared_ec2 (demo) | managed (prod)"
  type        = string
  validation {
    condition     = contains(["shared_ec2", "managed"], var.mode)
    error_message = "mode must be shared_ec2 or managed"
  }
}
variable "ec2_instance_type" {
  type    = string
  default = "t4g.medium"
}
variable "clickhouse_instance_type" {
  type    = string
  default = "r7g.xlarge"
}
variable "data_volume_gb" {
  type    = number
  default = 100
}
variable "opensearch_instance_type" {
  type    = string
  default = "r7g.large.search"
}
variable "opensearch_instance_count" {
  type    = number
  default = 3
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  name    = "marketplace-${var.env}"
  managed = var.mode == "managed"
}

resource "aws_security_group" "this" {
  name   = "${local.name}-search-analytics"
  vpc_id = var.vpc_id
  dynamic "ingress" {
    for_each = { es = 9200, opensearch = 443, clickhouse_http = 8123, clickhouse_native = 9000 }
    content {
      from_port       = ingress.value
      to_port         = ingress.value
      protocol        = "tcp"
      security_groups = var.client_security_group_ids
      description     = ingress.key
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = var.tags
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_iam_role" "node" {
  name = "${local.name}-search-analytics"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ec2.amazonaws.com" } }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "node" {
  name = "${local.name}-search-analytics"
  role = aws_iam_role.node.name
}

# demo: ES + ClickHouse together; prod: ClickHouse only.
resource "aws_instance" "node" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = local.managed ? var.clickhouse_instance_type : var.ec2_instance_type
  subnet_id              = var.subnet_ids[0]
  vpc_security_group_ids = [aws_security_group.this.id]
  iam_instance_profile   = aws_iam_instance_profile.node.name
  metadata_options { http_tokens = "required" }
  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }
  user_data = <<-EOT
    #!/bin/bash
    set -eux
    dnf install -y docker
    systemctl enable --now docker
    dev=$(lsblk -dpno NAME | grep -v "$(findmnt -no SOURCE / | sed 's/p[0-9]*$//')" | head -1)
    blkid "$dev" || mkfs.xfs "$dev"
    mkdir -p /data && mount "$dev" /data && echo "$dev /data xfs defaults,nofail 0 2" >> /etc/fstab
    mkdir -p /data/clickhouse /data/elasticsearch && chown 1000:1000 /data/elasticsearch
    docker run -d --name clickhouse --restart unless-stopped --network host --ulimit nofile=262144:262144 \
      -v /data/clickhouse:/var/lib/clickhouse clickhouse/clickhouse-server:25.8
    %{if !local.managed~}
    sysctl -w vm.max_map_count=262144
    docker run -d --name elasticsearch --restart unless-stopped --network host \
      -e discovery.type=single-node -e xpack.security.enabled=false -e ES_JAVA_OPTS="-Xms1g -Xmx1g" \
      -v /data/elasticsearch:/usr/share/elasticsearch/data docker.elastic.co/elasticsearch/elasticsearch:8.15.0
    %{endif~}
  EOT
  tags = merge(var.tags, { Name = local.managed ? "${local.name}-clickhouse" : "${local.name}-search-analytics" })
  lifecycle { ignore_changes = [ami, user_data] }
}

resource "aws_ebs_volume" "data" {
  availability_zone = aws_instance.node.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  tags              = merge(var.tags, { Name = "${local.name}-search-analytics-data" })
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.node.id
}

resource "aws_opensearch_domain" "this" {
  count          = local.managed ? 1 : 0
  domain_name    = "${local.name}-search"
  engine_version = "OpenSearch_2.17"
  cluster_config {
    instance_type            = var.opensearch_instance_type
    instance_count           = var.opensearch_instance_count
    zone_awareness_enabled   = true
    dedicated_master_enabled = true
    dedicated_master_type    = "m7g.large.search"
    dedicated_master_count   = 3
    zone_awareness_config { availability_zone_count = 2 }
  }
  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = 200
  }
  vpc_options {
    subnet_ids         = slice(var.subnet_ids, 0, 2)
    security_group_ids = [aws_security_group.this.id]
  }
  encrypt_at_rest { enabled = true }
  node_to_node_encryption { enabled = true }
  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-PFS-2023-10"
  }
  tags = var.tags
}

output "elasticsearch_url" { value = local.managed ? "https://${aws_opensearch_domain.this[0].endpoint}" : "http://${aws_instance.node.private_ip}:9200" }
output "clickhouse_url" { value = "http://${aws_instance.node.private_ip}:8123" }
output "security_group_id" { value = aws_security_group.this.id }
