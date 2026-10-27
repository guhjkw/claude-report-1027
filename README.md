# Case Report Studio (live demo)

Claude connected to a report that combines internal data into a plain-English format end users can act on. Built from an Upwork job post. It runs in the browser on two invented court records (a small claims case and a probate estate).

- **Facts first.** Code works out the stage, the dates ahead with countdowns, and the amounts from the docket. Claude never has to calculate.
- **Structured output.** The report has a fixed shape (headline, summary, what happens next, what you can do, timeline, glossary, caveats), the JSON schema the Claude request sends.
- **Checked before anyone sees it.** Every date, time, amount and day count is traced to the record; names the record never mentions are blocked; legal-advice phrasing is blocked; every upcoming date must be listed and none stale (a continuance retires the old date); every action must cite a docket entry; reading level is scored (grade 8 for the public); every legal term used must be in the glossary. A failed check shows users the plain record view instead.

In the demo, a stand-in drafter on the page writes the same JSON Claude returns, so the page needs no key and sends nothing anywhere. The "Claude request" tab shows exactly what a delivered build sends.

## Try it

Open `index.html` (works off disk), or `python3 -m http.server 8802`.

Try: move the trial date in the docket; add an "ORD CONT" entry that sets a new trial date; type `$5,000` into Claude's output; add "You will win" to an action; open the probate case and fix the impossible 2026-09-31 date.

## Files

```
index.src.html        page source (build.py embeds data/records.json into index.html)
index.html            the built page
src/caseReport.js     facts, draft, verify, request, renderHtml (the logic)
data/records.json     two invented court records
tests/verify.js       node tests against src/
tests/browser-check.py  Playwright: drives the page and downloads the report
```

## Run the tests

```
node tests/verify.js            # 61 checks: 61 passed, 0 failed
python3 tests/browser-check.py  # 31 browser checks: 31 passed, 0 failed
```

Saved runs: `tests/test-output.txt`, `tests/browser-output.txt`.

## How the logic works

| Step | What it does |
|---|---|
| Record checks | Impossible dates, entries after the report date, empty text, duplicate ids: left out and reported. Unknown codes: kept, shown as written, never interpreted |
| Facts | Stage from the furthest stage-moving entry; dates and times from "SET mm/dd/yyyy hh:mm", deadlines from "COMPLETE BY" and "DUE"; continuances replace earlier dates for the same event; countdowns from the report date |
| Draft | Plain sentences from the facts, actions tied to entries, glossary of the legal terms actually used, caveats with "not legal advice" |
| Verify | Shape; figures traced; names; advice; completeness and countdowns; action references; Flesch-Kincaid grade; jargon coverage |
| Request | claude-opus-5-5, server-side fallback on, `output_config` with effort low and the JSON schema; cost estimated at list price ($4 / $20 per million tokens) |

Settings (`DEFAULTS`): reader (public or staff), reading target per reader, summary length.

## What the delivered version adds

Read-only connection to your real data, the Claude call with your key in your environment, the fallback view and logging on your site, cost and failure logging per report, QA on 100 of your records, and documentation. All accounts in your name.

Sample data is invented. Built by Taiwo, Pathfinder Automation Solutions.
