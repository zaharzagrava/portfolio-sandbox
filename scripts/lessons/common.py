"""Shared parser for docs/lessons.md (format: see the top of that file)."""
import os
import re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LESSONS = os.path.join(ROOT, 'docs', 'lessons.md')
CLASSES = ('wiring', 'config', 'test-hollow', 'state-leak', 'timing', 'resources', 'process')

INDEX_RE = re.compile(r'^- (L-\d+) (\d{4}-\d{2}-\d{2}) (\S+) (\S+)\s*$')
HEAD_RE = re.compile(r'^## (L-\d+)\s+(.*)$')


class Lesson:
    def __init__(self, id_, date, cls, status):
        self.id, self.date, self.cls, self.status = id_, date, cls, status
        self.title = ''
        self.body = ''
        self.has_entry = False

    @property
    def rule(self):
        """The one-line rule: the **Rule:** line, else the first sentence of the prevention text."""
        m = re.search(r'^- \*\*Rule:\*\*\s*(.+)$', self.body, re.M)
        if m:
            return m.group(1).strip()
        m = re.search(r'\*\*Prevention(?: missing)?:\*\*\s*(.+?)(?:(?<=[a-z`)])\.(?:\s|$)|$)', self.body, re.S)
        if m:
            return ' '.join(m.group(1).split())
        return self.title

    @property
    def prevention_text(self):
        """Everything from the first **Prevention marker to the end of the entry (evidence follows it)."""
        m = re.search(r'\*\*(?:Prevention|Fixed by)', self.body)
        return self.body[m.start():] if m else ''


def parse(text):
    """Returns (lessons in index order, problems). A problem is a string about the file's structure."""
    lessons, by_id, problems = [], {}, []
    cur = None
    for line in text.split('\n'):
        m = INDEX_RE.match(line)
        if m and cur is None:
            if m.group(1) in by_id:
                problems.append(f'{m.group(1)} is listed twice in the index')
                continue
            les = Lesson(*m.groups())
            lessons.append(les)
            by_id[les.id] = les
            continue
        h = HEAD_RE.match(line)
        if h:
            cur = by_id.get(h.group(1))
            if cur is None:
                problems.append(f'{h.group(1)} has an entry but is not in the index')
            else:
                cur.title, cur.has_entry = h.group(2).strip(), True
            continue
        if cur is not None:
            cur.body += line + '\n'
    for les in lessons:
        if not les.has_entry:
            problems.append(f'{les.id} is in the index but has no "## {les.id}" entry')
        if les.status not in ('prevented', 'open'):
            problems.append(f'{les.id} has status "{les.status}" (use prevented or open)')
        if les.cls not in CLASSES:
            problems.append(f'{les.id} has class "{les.cls}" (known: {", ".join(CLASSES)})')
    return lessons, problems


def load(path=LESSONS):
    with open(path, encoding='utf-8') as f:
        return parse(f.read())


def repeats(lessons):
    """Per class: the lessons that were not the first of their class (by date, then id)."""
    seen, out = {}, {}
    for les in sorted(lessons, key=lambda x: (x.date, x.id)):
        if les.cls in seen:
            out.setdefault(les.cls, []).append(les.id)
        seen[les.cls] = True
    return out
