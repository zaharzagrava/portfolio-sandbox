#!/usr/bin/env bash
# How many of the 5 planted bugs did the AI QA flow find? Reads scripts/aiqa/findings/*.md (or the folder/files given) and
# prints a line per planted bug: FOUND with the finding title(s) that matched, or MISSED. Matching is by keywords (see
# RULES below), so a match is a strong hint, not proof: the scorer reads the shown findings and confirms.
#   score.sh [findings-folder-or-files ...]
# Findings written against clean code (before planting) should be moved away first, or they count as false hits; findings
# that only mention a planted file's area by chance are listed under "unmatched" for a quick look.
# Findings marked [FALSE] / [REJECTED] / [NOT-A-BUG] are ignored. Secret list of the bugs: reveal.md.
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$KIT" rev-parse --show-toplevel)"
[[ $# -eq 0 ]] && set -- "$ROOT/scripts/aiqa/findings"
python3 - "$@" <<'PY'
import glob, os, re, sys

BUGS = [
  ("1 wrong rule: suspended shop can still change products",
   [r"suspend|not.active|SHOP_NOT_ACTIVE|closing|deleting", r"product|inventory|stock", r"(accept|allow|succeed|200|201|should (be )?(refus|reject|block)|not (blocked|refused|rejected)|still (work|save|chang|creat|edit))"]),
  ("2 missing permission: viewer can restore a product",
   [r"restore|unarchive", r"viewer|read.only|products\.read|products\.write|permission|forbidden|403|role"]),
  ("3 off-by-one: seller orders page is one row short",
   [r"order", r"(page|paging|pagination|cursor|limit|next page|list)", r"(one (less|fewer|short|missing)|19|missing|never (show|list|appear)|skipp|lost|drop|fewer|off.by.one|empty page|no way forward|hidden)"]),
  ("4 lost update: edit with an old version is not refused",
   [r"version|stale|lost update|overwrit|two tabs|concurren|conflict|409|race", r"edit|update|patch|save|product"]),
  ("5 leaked data: public product shows private fields",
   [r"public|anonymous|storefront", r"(quantity|exact stock|createdBy|isSandbox|externalSku|seller id|user id|extra field|private field)"]),
]
IGNORE = re.compile(r"\[(FALSE|REJECTED|NOT-A-BUG|NOT A BUG|DUPLICATE)", re.I)
HEAD = re.compile(r"^\s*(?:#+\s*)?(?:\*\*)?([A-Za-z0-9\-_.]*F\d+)\b[^\n]*", re.M)

files = []
for arg in sys.argv[1:]:
    files += sorted(glob.glob(os.path.join(arg, "*.md"))) if os.path.isdir(arg) else [arg]
blocks = []
for f in files:
    text = open(f, encoding="utf-8", errors="replace").read()
    marks = list(HEAD.finditer(text))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        title = m.group(0).strip()
        if IGNORE.search(title):
            continue
        blocks.append((os.path.basename(f), title[:140], text[m.start():end]))

print(f"{len(blocks)} findings read from {len(files)} file(s)\n")
hit_blocks, found = set(), 0
for name, pats in BUGS:
    hits = [i for i, (_, _, body) in enumerate(blocks) if all(re.search(p, body, re.I) for p in pats)]
    hit_blocks.update(hits)
    if hits:
        found += 1
        print(f"FOUND   {name}")
        for i in hits[:4]:
            print(f"          {blocks[i][0]}: {blocks[i][1]}")
        if len(hits) > 4:
            print(f"          ... and {len(hits) - 4} more")
    else:
        print(f"MISSED  {name}")
print(f"\nScore: {found} of {len(BUGS)} planted bugs found (keyword match; confirm the shown findings by hand)")
rest = [b for i, b in enumerate(blocks) if i not in hit_blocks]
print(f"Findings that matched no planted bug: {len(rest)} (real bugs, noise, or planted bugs described in other words)")
PY
