#!/usr/bin/env python3
"""Which QA charters should run now? The QA agent cannot cover everything, so it covers what changed.

  scripts/qa/select.py [--budget MIN] [--explain]     the charters to run, one line, space separated (default budget: $QA_BUDGET_MIN or 30)
  scripts/qa/select.py --all                           every charter (for scripts/qa/full.sh)
  scripts/qa/select.py --uncovered                     built capabilities that no charter lists (input of scripts/qa/make-charters.sh)

A charter lists capabilities (`specs: S10 S13`). A capability counts as changed when a commit touched its `scope:` paths (from its living page in
docs/spec/capabilities) after the charter's last report in specs/.qa. A charter that never ran is due once any of its capabilities has been built.
Order: most changed capabilities first, then the longest without a run. Charters are taken in that order while they fit the budget (their minutes plus
6 for verify and the test); the first one is always taken. Draft charters (`status: draft`, written by make-charters.sh) take part like the others.
"""
import argparse, glob, os, re, subprocess, sys
from datetime import datetime

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
QA, CAPS = os.path.join(ROOT, "scripts/qa"), os.path.join(ROOT, "docs/spec/capabilities")
OVERHEAD = 6


def front(path):
    d = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r"(name|specs|status|minutes):\s*(.*)", line)
        if m: d[m.group(1)] = m.group(2).strip()
        if line.startswith("minutes:"): break
    return d


def charters():
    out = {}
    for f in sorted(glob.glob(os.path.join(QA, "charters", "*.md"))):
        d = front(f)
        out[d.get("name", os.path.basename(f)[:-3])] = {"specs": d.get("specs", "").split(), "minutes": int(d.get("minutes", "15") or 15), "status": d.get("status", "")}
    return out


def scope(cap_id):
    pages = sorted(glob.glob(os.path.join(CAPS, f"{cap_id}-*.md")))
    if not pages: return None
    paths, on = [], False
    for line in open(pages[0], encoding="utf-8"):
        if line.startswith("scope:"): on = True; continue
        if on:
            m = re.match(r"\s+-\s+(\S+)", line)
            if m: paths.append(m.group(1).strip("'\""))
            else: break
    return paths


def commits(paths, since=None):
    if not paths: return 0
    cmd = ["git", "-C", ROOT, "log", "--format=%H"] + ([f"--since={since}"] if since else []) + ["--"] + [f":(glob){p}" for p in paths]
    return len(subprocess.run(cmd, capture_output=True, text=True).stdout.split())


def last_run(name):
    stamps = [re.match(r"(\d{4}-\d{2}-\d{2})-(\d{4})", os.path.basename(f)) for f in glob.glob(os.path.join(ROOT, f"specs/.qa/*-{name}.md"))]
    stamps = sorted(f"{m.group(1)} {m.group(2)[:2]}:{m.group(2)[2:]}" for m in stamps if m)
    return stamps[-1] if stamps else None


def due(name, c):
    since, changed, built = last_run(name), [], []
    for cap in c["specs"]:
        p = scope(cap)
        if p is None: continue
        n = commits(p, since) if since else commits(p)
        if n: changed.append(cap)
    return since, changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=int, default=int(os.environ.get("QA_BUDGET_MIN") or 30))
    ap.add_argument("--explain", action="store_true"); ap.add_argument("--all", action="store_true"); ap.add_argument("--uncovered", action="store_true")
    a = ap.parse_args(); ch = charters()
    if a.all: print(" ".join(ch)); return
    if a.uncovered:
        listed = {s for c in ch.values() for s in c["specs"]}
        skip = set(open(os.path.join(QA, "charters", ".no-flow")).read().split()) if os.path.exists(os.path.join(QA, "charters", ".no-flow")) else set()
        for f in sorted(glob.glob(os.path.join(CAPS, "*.md"))):
            cid = os.path.basename(f).split("-")[0]
            if cid not in listed and cid not in skip and commits(scope(cid) or []): print(cid)
        return
    rows = []
    for name, c in ch.items():
        since, changed = due(name, c)
        if changed: rows.append((-len(changed), since or "", name, changed, since))
    rows.sort()
    picked, used = [], 0
    for _, _, name, changed, since in rows:
        cost = ch[name]["minutes"] + OVERHEAD
        if picked and used + cost > a.budget:
            if a.explain: print(f"later  {name}: changed {' '.join(changed)} but the budget ({a.budget} min) is used", file=sys.stderr)
            continue
        picked.append(name); used += cost
        if a.explain: print(f"run    {name}{' (draft)' if ch[name]['status'] == 'draft' else ''}: changed {' '.join(changed)}; last run {since or 'never'}; {cost} min", file=sys.stderr)
    if a.explain:
        for name in ch:
            if name not in picked and not any(r[2] == name for r in rows): print(f"skip   {name}: nothing it covers changed since its last run", file=sys.stderr)
    print(" ".join(picked))


main()
