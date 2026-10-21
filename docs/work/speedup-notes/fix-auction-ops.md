# Auction operations log test (S21 AS-51)

What failed: in the full run, the test "log lines are JSON ... never a maximum" saw a forbidden value in the captured output.

What I did: the old logs of that run were gone. I could not reproduce the failure (the file alone, and with four likely neighbours on shard 6, passed). No code was changed.

Best guess, not proven: the test looks for the digit strings 7777 and 6543 anywhere in all captured text. Every log line carries random trace, span and request ids, a clock value and a process id, and these can hold those four digits by chance. Other files in the same process write to the same output, which adds more lines and raises the chance in full runs.

Possible fix (needs your decision, because it narrows what the test searches): look for the two amounts only in the content of each line, after removing the machine-made fields (time, pid, hostname, traceId, spanId, requestId, responseTime). Emails and the token would still be searched in the whole output. Alternative: use bid amounts that cannot appear by chance, for example amounts with a distinctive 7-digit pattern that does not fit hex ids or timestamps.
