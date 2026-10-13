# A wiring defect of the same family as 2026-10-12: the charge consumer is never registered, so every queue exists, the message is delivered to the queue and nothing reads it.
EXPECT='payment|charge|PENDING|consum|worker|queue'
F=packages/backend/libs/domains/payments/infra/charge-command.worker.ts
apply()  { python3 - <<'P'
p='packages/backend/libs/domains/payments/infra/charge-command.worker.ts'; s=open(p).read()
t="    if (!this.queue) return;\n    this.stop = this.queue.consume<ChargeCommand>("
assert t in s; open(p,'w').write(s.replace(t,"    return;\n    this.stop = this.queue!.consume<ChargeCommand>(",1))
P
  sleep 15; for _ in $(seq 1 60); do curl -sf localhost:8000/health/ready >/dev/null && break; sleep 3; done; sleep 15; }
revert() { git checkout $F; sleep 15; for _ in $(seq 1 60); do curl -sf localhost:8000/health/ready >/dev/null && break; sleep 3; done; sleep 15; }
