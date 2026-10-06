#!/bin/bash
# Shared by the hooks. release.env is written by deploy.yml; on scale-out (no deployment) user-data writes it from SSM.
set -euo pipefail
RELEASE_DIR=/opt/marketplace/release
# shellcheck disable=SC1091
source "$RELEASE_DIR/release.env"
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/placement/region)
CONTAINER=marketplace-app
