#!/usr/bin/env python3
"""Decisions that need a person: the 'questions.md' files, triaged.

Every capability the loop builds leaves specs/<kind>/<id>-<slug>/questions.md: the defaults the agent chose instead of asking you (hundreds of lines in
total). Nobody can read them all, so this script reads them for you and keeps the few that are YOURS to decide (money, privacy, security, visible behavior,
compatibility, cost) in docs/decisions/<id>.md, with the default taken, the alternatives and the cost of a wrong default. The rest is counted and archived.

  triage.py generate [ID ...] [--force] [--jobs N]    write docs/decisions/<id>.md for built capabilities (all, or the ones named) that have none (or --force)
  triage.py status                                    open / keep / change counts per capability; exit 1 when a file is malformed
  triage.py open                                      the open decisions, one line each (what to read first)

You answer by editing the `status:` line under a decision: `status: keep` (the default stands) or `status: change: <what you want instead>`.
A `change` is picked up by the next loop run as a task (scripts/sdd/implement-specs.sh reads docs/decisions, "decisions to apply"); `scripts/decisions/triage.py status`
shows what is still open. The model is called with no tools, in a scratch directory, with the questions and the living page as its only input.
"""
import concurrent.futures as cf
import datetime
import glob
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'livespec'))
import common  # noqa: E402
import generate  # noqa: E402

ROOT = common.ROOT
OUT = os.path.join(ROOT, 'docs', 'decisions')
ITEM = re.compile(r'^- \*\*([A-Z0-9]+\.D-\d+)\*\*\s*(.*)$')
STATUS = re.compile(r'^\s+- status:\s*(open|keep|change:\s*\S.*)\s*$')
MAX_DECISIONS = 8

PROMPT = """You triage the decisions an unattended build agent made on behalf of its owner. Below: the file of defaults it recorded for capability {cid} ({title}), and the rules of
its living specification page. Pick the decisions only the OWNER (a product-minded engineer who is not reading code) should decide: money, payments and refunds, privacy and personal data,
security and access, what the customer sees or can do, compatibility with something that exists, cost or limits that change what the product offers. Skip purely technical choices (naming,
internal shapes, batch sizes, test setup) and choices that follow directly from another rule.

Write at most {maxn} decisions, strongest first, in EXACTLY this shape (plain markdown, no tables, no preamble, no code fence):

---
id: {cid}
title: Decisions for {title}
generated: {today}
---
# Decisions needing your call: {cid} {title}
<one sentence: how many defaults were recorded and how many need you>

- **{cid}.D-01** <the decision as a question in one sentence, plain words>
  - default: <what the agent chose, with a number or name>
  - alternatives: <one or two real alternatives>
  - if wrong: <what a wrong default costs: money, customers, rework>
  - source: <the questions.md line it came from, first 8 words, with its tag>
  - status: open

## Left to the agent
<one or two sentences: what kinds of choices were skipped and how many lines there are>

If nothing needs the owner, write the front matter, the heading, the sentence, and under it the line "No decision needs you." Do not invent decisions the file does not hold.

# questions.md of {cid}
{questions}

# Living page rules of {cid}
{rules}
"""


def questions_of(info):
    p = os.path.join(info['dir'], 'questions.md')
    if not os.path.exists(p):
        return '', 0
    text = common.read(p, errors='ignore')
    lines = [l for l in text.split('\n') if re.match(r'^\s*(- \[(BREAKING|CONTRACT)\]|\d+\.\s)', l)]
    total = len(re.findall(r'^- \[(BREAKING|CONTRACT|LOCAL)\]', text, re.M)) or len(lines)
    body = '\n'.join(lines)
    return body[:60000], total


def rules_of(cid):
    for p in glob.glob(os.path.join(common.SPEC, 'capabilities', f'{cid}-*.md')):
        page = common.load_page(p)
        return '\n'.join(f'- {i["id"]} {common.strip_refs(i["text"])[:300]}' for i in page['items'] if '.R-' in i['id'])[:12000]
    return '(no living page yet)'


def generate_one(cid, info, force):
    out = os.path.join(OUT, f'{cid}.md')
    if os.path.exists(out) and not force:
        return cid, 'kept'
    q, total = questions_of(info)
    if not q:
        return cid, 'no questions'
    prompt = PROMPT.format(cid=cid, title=info['title'], maxn=MAX_DECISIONS, today=datetime.date.today().isoformat(), questions=q, rules=rules_of(cid))
    text = generate.call_model(prompt).strip()
    text = re.sub(r'^```(?:markdown|md)?\n|\n```\s*$', '', text)
    m = re.search(r'^---\n', text, re.M)
    text = text[m.start():] if m else text
    problems = check_text(text, cid)
    if problems:
        raise RuntimeError(f'{cid}: malformed answer: {problems[0]}')
    os.makedirs(OUT, exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(text.rstrip() + f'\n\n_Source: {total} recorded default(s) in `{os.path.relpath(os.path.join(info["dir"], "questions.md"), ROOT)}`._\n')
    return cid, f'written ({len(parse(text))} decision(s))'


def parse(text):
    """-> list of {'id','text','status'}"""
    out, cur = [], None
    for line in text.split('\n'):
        m = ITEM.match(line)
        if m:
            cur = {'id': m.group(1), 'text': m.group(2), 'status': None}
            out.append(cur)
            continue
        s = STATUS.match(line)
        if s and cur:
            cur['status'] = s.group(1).split(':')[0]
            cur['note'] = s.group(1)
    return out


def check_text(text, cid):
    problems = []
    if not text.startswith('---\n'):
        problems.append('no front matter')
    items = parse(text)
    for i in items:
        if not i['id'].startswith(cid + '.'):
            problems.append(f'{i["id"]} does not belong to {cid}')
        if i['status'] is None:
            problems.append(f'{i["id"]} has no `- status:` line (open, keep, change: <what>)')
    if len(items) > MAX_DECISIONS + 2:
        problems.append(f'{len(items)} decisions (more than {MAX_DECISIONS}: the point is to keep few)')
    return problems


def files():
    return sorted(glob.glob(os.path.join(OUT, '*.md')))


def cmd_status():
    bad, tot = 0, {'open': 0, 'keep': 0, 'change': 0}
    for p in files():
        cid = os.path.basename(p).split('.')[0]
        text = common.read(p)
        for pr in check_text(text, cid):
            print(f'ERROR {os.path.relpath(p, ROOT)}: {pr}')
            bad += 1
        items = parse(text)
        c = {k: sum(1 for i in items if i['status'] == k) for k in tot}
        for k in tot:
            tot[k] += c[k]
        print(f'{cid:5} open {c["open"]}, keep {c["keep"]}, change {c["change"]}')
    print(f'-- {len(files())} file(s): open {tot["open"]}, keep {tot["keep"]}, change {tot["change"]}')
    return 1 if bad else 0


def cmd_open():
    for p in files():
        for i in parse(common.read(p)):
            if i['status'] == 'open':
                print(f'{i["id"]}  {i["text"]}')
    return 0


def main(argv):
    cmd = argv[0] if argv else ''
    if cmd == 'status':
        return cmd_status()
    if cmd == 'open':
        return cmd_open()
    if cmd == 'generate':
        force = '--force' in argv
        jobs = int(argv[argv.index('--jobs') + 1]) if '--jobs' in argv else 3
        wanted = [a for a in argv[1:] if re.fullmatch(r'[SWJ]\d{2}', a)]
        built = {k: v for k, v in generate.built_capabilities().items() if not wanted or k in wanted}
        rc = 0
        with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
            futs = {ex.submit(generate_one, k, v, force): k for k, v in built.items()}
            for f in cf.as_completed(futs):
                try:
                    print(*f.result())
                except Exception as e:  # noqa: BLE001
                    print(futs[f], 'FAILED', e)
                    rc = 1
        return rc
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
