#!/bin/bash
# By now CodeDeploy has deregistered the instance and waited the target group's deregistration delay (connection drain).
# docker stop sends SIGTERM → tini → node: F-01 graceful shutdown (readiness off, finish requests, close pools, flush telemetry).
# 35 s > the app's shutdown budget (30 s); only then SIGKILL.
set -uo pipefail
if docker inspect marketplace-app >/dev/null 2>&1; then
  docker stop --time 35 marketplace-app || true
  docker rm marketplace-app || true
fi
