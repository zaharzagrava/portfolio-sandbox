#!/usr/bin/env bash
# O-03: plan + apply the demo environment, with an explicit confirmation. Never run by automation.
# Prereqs: `infra/bootstrap` applied once; envs/demo/terraform.tfvars filled; AWS/Confluent/Cloudflare/Upstash
# credentials in the environment; `pnpm --filter api build:lambdas` run (Terraform reads its manifest.json).
set -euo pipefail
cd "$(dirname "$0")/envs/${1:-demo}"
[ -f terraform.tfvars ] || { echo "missing $(pwd)/terraform.tfvars (copy terraform.tfvars.example)"; exit 1; }
terraform init -upgrade
terraform plan -out=tfplan
read -r -p "Apply this plan to ${1:-demo}? (yes/no) " answer
[ "$answer" = "yes" ] && terraform apply tfplan || echo "Apply cancelled."
