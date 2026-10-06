#!/bin/bash
# Pull before the old container stops, so the stop→start gap is seconds, not an image download.
source "$(dirname "$0")/common.sh"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${IMAGE%%/*}"
docker pull "$IMAGE"
