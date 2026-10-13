# 2026-10-12: the charge request carried a message group; the standard queue refused it and the payment stayed PENDING.
EXPECT='payment|charge|groupId|500|queue'
apply()  { python3 - <<'P'
p='packages/backend/libs/domains/payments/application/payment-intent.service.ts'; s=open(p).read()
t="        aggregateId: id,\n        body: { paymentId: id, attempt: 0 },"
assert t in s; open(p,'w').write(s.replace(t,"        aggregateId: id,\n        groupId: id,\n        body: { paymentId: id, attempt: 0 },",1))
P
  sleep 15; for _ in $(seq 1 60); do curl -sf localhost:8000/health/ready >/dev/null && break; sleep 3; done; sleep 15; }
revert() { git checkout packages/backend/libs/domains/payments/application/payment-intent.service.ts; sleep 15; for _ in $(seq 1 60); do curl -sf localhost:8000/health/ready >/dev/null && break; sleep 3; done; sleep 15; }
