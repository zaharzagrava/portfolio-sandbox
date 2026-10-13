# 2026-10-12: the queue the charge worker reads was not defined in the queue server's configuration.
EXPECT='payments-charge|queue'
apply()  { curl -s "localhost:9324/000000000000/payments-charge?Action=DeleteQueue" >/dev/null; }
revert() { curl -s "localhost:9324/?Action=CreateQueue&QueueName=payments-charge" >/dev/null; }
