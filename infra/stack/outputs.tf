# Values the app secret needs (put them in `marketplace/<env>/app` together with the real secrets) and GitHub vars.
output "github_vars" {
  value = {
    AWS_BUILD_ROLE_ARN  = module.github.build_role_arn
    AWS_DEPLOY_ROLE_ARN = module.github.deploy_role_arn
    ARTIFACTS_BUCKET    = module.storage.artifacts_bucket
    ECR_REGISTRY        = split("/", values(module.ecr.repository_urls)[0])[0]
  }
}

output "app_config" {
  value = {
    DB_HOST                  = module.rds.endpoint
    DB_READ_HOST             = module.rds.read_endpoint
    REDIS_URL                = "rediss://${module.redis.primary_endpoint}:6379"
    KAFKA_BROKER             = module.kafka.bootstrap_endpoint
    KAFKA_API_KEY            = module.kafka.api_key
    ELASTICSEARCH_NODE       = module.search_analytics.elasticsearch_url
    CLICKHOUSE_URL           = module.search_analytics.clickhouse_url
    MEDIA_BUCKET             = module.storage.media_bucket
    CDN_DOMAIN               = module.storage.cdn_domain
    SQS_QUEUE_URL_PREFIX     = replace(values(module.sqs.queue_urls)[0], "/[^/]+$/", "${var.env}-")
    DYNAMO_TABLE_PREFIX      = "${var.env}_"
    CASSANDRA_CONTACT_POINTS = module.keyspaces.contact_point
    CASSANDRA_KEYSPACE       = module.keyspaces.keyspace
    CASSANDRA_LOCAL_DC       = data.aws_region.current.name
  }
}

output "alb_dns_name" { value = module.alb.dns_name }

data "aws_region" "current" {}
