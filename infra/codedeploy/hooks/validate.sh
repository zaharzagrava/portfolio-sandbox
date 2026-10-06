#!/bin/bash
# Same probe as the target group: /readyz turns 200 only when DB/Redis/Kafka connections are up (F-01).
# Failing here fails the deployment → CodeDeploy keeps the old (blue) fleet serving and rolls back.
source "$(dirname "$0")/common.sh"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null http://localhost:8000/readyz; then exit 0; fi
  sleep 3
done
docker logs --tail 100 "$CONTAINER" || true
exit 1
