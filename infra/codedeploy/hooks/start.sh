#!/bin/bash
# Runtime config comes from Secrets Manager inside the app (AWS_SECRET_ID); nothing secret is passed on the command line.
source "$(dirname "$0")/common.sh"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024*0.85)}' /proc/meminfo)
docker run -d --name "$CONTAINER" --restart unless-stopped \
  --memory "${MEM_MB}m" \
  --network host \
  --log-driver awslogs --log-opt awslogs-region="$REGION" --log-opt awslogs-group="/marketplace/$ENV/$APP" --log-opt awslogs-create-group=false \
  -e NODE_ENV=production -e APP_VERSION="${IMAGE##*:}" -e AWS_REGION="$REGION" -e AWS_SECRET_ID="marketplace/$ENV/app" \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 -e METRICS_PORT=9464 \
  "$IMAGE"
