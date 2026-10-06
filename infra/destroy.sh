#!/usr/bin/env bash
# O-03: tear down the DEMO environment (cost control). Refuses prod: prod data stores also have deletion
# protection (RDS, DynamoDB) and a final snapshot, so even a forced destroy fails safe.
set -euo pipefail
env="${1:-demo}"
[ "$env" = "prod" ] && { echo "Refusing to destroy prod."; exit 1; }
cd "$(dirname "$0")/envs/$env"
terraform init
read -r -p "Type the environment name to destroy it: " answer
[ "$answer" = "$env" ] && terraform destroy || echo "Cancelled."
