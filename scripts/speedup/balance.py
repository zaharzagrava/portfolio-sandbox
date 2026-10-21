#!/usr/bin/env python3
"""balance.py <N> <durations.json> <all-specs-file> <out-dir>

Splits the e2e spec files into N lists of about equal TOTAL TIME (not equal file count): files longest first, each to the list with the least
time so far. Time of a file = what the last run measured (durations.json: {path: seconds}); a file without a measurement counts as the median.
Writes <out-dir>/list-1.txt ... list-N.txt (one path per line, relative to packages/backend) and prints the planned time of each list.
"""
import json, os, statistics, sys

n, dur_path, all_path, out = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
files = [l.strip() for l in open(all_path) if l.strip()]
dur = json.load(open(dur_path)) if os.path.exists(dur_path) else {}
known = [dur[f] for f in files if f in dur]
fallback = statistics.median(known) if known else 1.0
weight = {f: dur.get(f, fallback) for f in files}
loads = [0.0] * n
lists = [[] for _ in range(n)]
for f in sorted(files, key=lambda f: -weight[f]):
    i = loads.index(min(loads))
    lists[i].append(f)
    loads[i] += weight[f]
os.makedirs(out, exist_ok=True)
for i, lst in enumerate(lists, 1):
    open(os.path.join(out, f"list-{i}.txt"), "w").write("\n".join(lst) + "\n")
print("planned seconds per list: " + ", ".join("%.0f" % x for x in loads) + "  (files without a measurement: %d)" % sum(1 for f in files if f not in dur))
