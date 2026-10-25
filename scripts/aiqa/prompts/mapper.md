You build the QA coverage map for ONE area of the seller dashboard. Area: {{AREA}}. Pages and files in scope: {{SCOPE}}. Time budget: 25 minutes; write the files by then even if unfinished (say what is missing).

IMPORTANT: the live page is the starting point, the spec is only the baseline. Open each page in a real browser (stack: web http://localhost:3000, demo seller seller@marketplace.local / Demo-Seed-Pw-7491!), and list every button, toggle, link, field and state you can see or reach, with the page open at desktop and 390 px width, as each role. For EACH thing found, trace it all the way down: what it is for -> which spec rule/behavior covers it (or none) -> which component and handler in the code -> which API route -> which backend service -> which database table/column (and outbox/queue message) it reads or writes. Nothing that exists on the page may be left out or skipped because the spec does not mention it. Put the whole trace in the line (use the `code` column as `component > api route > service > table`).

Read first: scripts/aiqa/README.md (the method). The repo is /home/zagrava/workspace/personal-projects/portfolio-sandbox. Rules: plain language, read-only on product code and tests, no git stash/reset/checkout, no commits.

What to do:
1. Spec side. The spec is a graph of files in docs/spec/capabilities (each file has id, depends_on, scope, Rules R-xx, Behaviors B-xx, acceptance scenarios AS-xx often in specs/web/<id>/test-plan.md, and `{{cap:X}}` links to other capabilities). Start at docs/spec/capabilities/W04-seller-dashboard.md and follow the links and depends_on (S03 shops, S05 products, media, orders, W01 session, W03 realtime ...) wherever they say something about the pages in scope. Collect every rule/behavior that touches the area.
2. Code side. Read the page files, every component they use (packages/web/components/seller/**, packages/web/app/dashboard/seller/**, packages/web/lib/seller/**, lib/api/seller*.ts), and the backend endpoints they call (controllers under packages/backend/libs/domains/**), and the database tables those endpoints write. List EVERY control a person can touch: each button, link, toggle, checkbox, select, text field, menu entry, tab, dialog and its buttons, keyboard shortcuts, drag handles, sort/paging controls, empty/loading/error states, responsive (390 px phone) behaviors, permission variants (OWNER, ADMIN, STAFF, VIEWER), shop status variants (ACTIVE, SUSPENDED, DELETING).
3. Write scripts/aiqa/coverage/{{AREA}}.tsv. Tab-separated, first line is the header:
   id<TAB>what<TAB>spec<TAB>code<TAB>layers<TAB>status<TAB>date<TAB>by<TAB>bugs<TAB>note
   - id: `{{AREA}}.<section>.<item>`, lower-case, dashes (example `inventory.search.box`, `inventory.add-product.create-button`).
   - what: one sentence a tester can act on: the action and the expected result on screen, in the API answer, and in the database (name the table/column when it writes).
   - spec: spec ids (W04.B-11, W04.R-10, S05.R-19 ...) or `none` for code-only items.
   - code: file path (and component/function) that builds it.
   - layers: the layers that must be checked, a subset of `ui,api,db`.
   - status: `untested` for all lines. date, by, bugs, note: empty.
   - One line per control AND one line per rule/behavior that is not already one control (for example "double press sends one request"). Expect 60 to 200 lines for a page. Do not merge different buttons into one line. Do not invent controls that are not in the code.
4. Write scripts/aiqa/coverage/{{AREA}}.gaps.md with three plain lists: (a) in the code but not in the spec, (b) in the spec but not found in the code (likely bugs), (c) spec and code disagree (quote both). Each with file paths.
5. Run `node scripts/aiqa/status.mjs {{AREA}}` and fix format problems. Finish with a short plain-language summary: number of lines, number of gaps found per list, anything you could not map.
