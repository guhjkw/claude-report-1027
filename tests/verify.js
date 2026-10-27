// tests/verify.js: node tests against the same engine the page loads.  Run: node tests/verify.js
'use strict';
const C = require('../src/caseReport.js');
const DATA = require('../data/records.json');
const clone = (x) => JSON.parse(JSON.stringify(x));
const AS_OF = DATA.asOf, SC = DATA.records[0], PB = DATA.records[1];
let passed = 0, failed = 0;
const ok = (name, cond, detail) => { if (cond) { passed++; console.log('  PASS ' + name); } else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); } };
const section = (t) => console.log('\n' + t);
const blocks = (v, check) => v.issues.filter((i) => i.severity === 'block' && (!check || i.check === check));
// A small JSON-schema check (type, required, properties, additionalProperties:false, items), enough to prove
// the draft fits the exact schema the request sends.
function fits(value, schema, path) {
  path = path || '$';
  const t = schema.type, errs = [];
  const typeOk = t === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : t === 'array' ? Array.isArray(value) : t === 'integer' ? Number.isInteger(value) : typeof value === t;
  if (!typeOk) return [path + ' should be ' + t];
  if (t === 'object') {
    (schema.required || []).forEach((k) => { if (!(k in value)) errs.push(path + '.' + k + ' missing'); });
    Object.keys(value).forEach((k) => { if (schema.properties[k]) errs.push(...fits(value[k], schema.properties[k], path + '.' + k)); else if (schema.additionalProperties === false) errs.push(path + '.' + k + ' not allowed'); });
  }
  if (t === 'array') value.forEach((v, i) => errs.push(...fits(v, schema.items, path + '[' + i + ']')));
  return errs;
}

section('1. Record checks: bad entries are left out and reported, never fatal');
const pf = C.facts(PB, AS_OF);
ok('an impossible date (September 31) is left out with a reason', pf.problems.some((p) => /P8: impossible date "2026-09-31", left out; the court date it mentions/.test(p)) && !pf.entries.some((e) => e.id === 'P8'));
ok('an unknown code is kept, shown as written, and reported', pf.entries.find((e) => e.id === 'P7').plain === 'Court entry (code not recognized): Obj to clm filed by pr' && pf.problems.some((p) => /OBJ CLM X/.test(p)));
const bad = clone(SC);
bad.docket.push({ id: 'D10', date: '2026-11-02', code: 'ANS', text: 'LATE ENTRY' }, { id: 'D11', date: '2026-10-01', code: 'FEE', text: '  ' }, { id: 'D5', date: '2026-10-02', code: 'FEE', text: 'COPY FEE $10.00' }, null);
const bf = C.facts(bad, AS_OF);
ok('an entry dated after the report date is left out', bf.problems.some((p) => /D10: dated 2026-11-02, after the report date/.test(p)));
ok('an entry with no text is left out', bf.problems.some((p) => /D11: no text/.test(p)));
ok('a duplicate id is renamed and reported', bf.entries.some((e) => e.id === 'D5-12') && bf.problems.some((p) => /duplicate id/.test(p)));
ok('a non-entry row is left out', bf.problems.some((p) => /not an entry/.test(p)));
ok('a report date that is not a real date is reported', C.facts(SC, '2026-02-30').problems.some((p) => /not a real date/.test(p)));

section('2. Facts from the record');
const sf = C.facts(SC, AS_OF);
ok('the small claims case is at Mediation, open 74 days', sf.stage === 'Mediation' && sf.daysOpen === 74);
ok('two dates ahead: mediation deadline Nov 20 (24 days) and trial Dec 8 at 13:30 (42 days)', sf.upcoming.map((e) => e.ref + e.date + e.daysUntil).join('|') === 'D82026-11-2024|D92026-12-0842' && sf.upcoming[1].time === '13:30' && sf.upcoming[1].room === 'Courtroom 3B');
ok('the pretrial conference on Oct 21 is known and marked as past', sf.events.find((e) => e.ref === 'D6').past);
ok('amounts come from the docket and the claim: $4,850 and $175', sf.money.map((m) => m.value).sort((a, b) => a - b).join() === '175,4850,4850');
ok('the probate case is at Claims, open 146 days, with no dates ahead', pf.stage === 'Claims' && pf.daysOpen === 146 && pf.upcoming.length === 0);
const fixed = clone(PB); fixed.docket[7].date = '2026-09-30';
const ff = C.facts(fixed, AS_OF);
ok('fixing the date brings back the hearing: Nov 5 at 10:00 in Room 210, 9 days away', ff.upcoming.length === 1 && ff.upcoming[0].date === '2026-11-05' && ff.upcoming[0].room === 'Room 210' && ff.upcoming[0].daysUntil === 9, ff.upcoming);
ok('a later report date moves the countdown (Nov 21: mediation deadline passed, trial in 17 days)', C.facts(SC, '2026-11-21').upcoming.map((e) => e.ref + ':' + e.daysUntil).join() === 'D9:17');

const cont = clone(SC); cont.docket.push({ id: 'D10', date: '2026-10-26', code: 'ORD CONT', text: 'ORDER CONTINUING TRIAL SET 01/12/2027 13:30 CTRM 3B' });
const cf = C.facts(cont, AS_OF);
ok('a continuance moves the trial: January 12, 2027 replaces December 8', cf.upcoming.map((e) => e.what + ' ' + e.date).join('|') === 'Mediation must be finished 2026-11-20|Trial 2027-01-12' && cf.events.find((e) => e.ref === 'D9').movedTo === '2027-01-12', cf.upcoming);
const contStale = C.draft(SC, AS_OF);
ok('a report that still lists December 8 after the move is blocked', blocks(C.verify(contStale, cont, AS_OF), 'complete').some((i) => /moved to January 12, 2027/.test(i.detail)));
ok('the report drafted after the move passes', C.verify(C.draft(cont, AS_OF), cont, AS_OF).ok);

section('3. The drafted report');
const r = C.draft(SC, AS_OF);
ok('the summary names both sides and the amount', /Marisol Ortega is asking Brightline Auto Repair LLC for \$4,850\./.test(r.summary));
ok('it says what happens next in date order', /mediation deadline on November 20, 2026\. After that, the trial is set for December 8, 2026 at 1:30 PM\./.test(r.summary));
ok('"What happens next" lists both dates with countdowns', r.next.length === 2 && r.next[0].daysUntil === 24 && r.next[1].where === 'Courtroom 3B');
ok('every action cites an entry: D8, D9, D5, then general help', r.actions.map((a) => a.ref).join() === 'D8,D9,D5,general');
ok('the timeline explains each entry in plain English', r.timeline.length === 9 && /officially given the papers on August 29, 2026/.test(r.timeline[3].text));
ok('the glossary explains every legal term used', ['mediation', 'trial', 'summons', 'answer', 'complaint', 'pretrial conference', 'small claims', 'service', 'hearing'].every((t) => r.glossary.some((g) => g.term === t)), r.glossary.map((g) => g.term));
ok('the caveats say it is not legal advice', /not legal advice/.test(r.caveats));
const staff = C.draft(SC, AS_OF, { audience: 'staff' });
ok('the staff version shows codes, calendars dates and has no glossary', /\[NTC TRL\]/.test(staff.timeline[8].text) && /^Calendar: trial/.test(staff.actions[1].text) && !staff.glossary.length);
const pr = C.draft(PB, AS_OF);
ok('the probate report says there are no dates ahead and that 2 entries had problems', /No future court dates are on the record as of October 27, 2026\./.test(pr.summary) && /2 docket entries were not shown in full/.test(pr.caveats));
ok('the unknown code is not interpreted', !/objection/i.test(pr.summary));

section('4. Clean drafts pass every check');
let v = C.verify(r, SC, AS_OF);
ok('small claims: 31 of 31 figures traced, reading grade 6.5, no issues', v.ok && v.figures === 31 && v.traced === 31 && v.grade === 6.5 && !v.issues.length, [v.figures, v.traced, v.grade, v.issues]);
v = C.verify(pr, PB, AS_OF);
ok('probate: 18 of 18 figures traced, no issues', v.ok && v.figures === 18 && v.traced === 18, [v.figures, v.issues]);
ok('the staff version passes its own checks', C.verify(staff, SC, AS_OF, { audience: 'staff' }).ok);
ok('the drafts fit the exact schema the request sends', !fits(r, C.SCHEMA).length && !fits(pr, C.SCHEMA).length && !fits(staff, C.SCHEMA).length, fits(r, C.SCHEMA));

section('5. The checks catch what a model (or a person) gets wrong');
const t = (mut) => { const x = clone(r); mut(x); return C.verify(x, SC, AS_OF); };
v = t((x) => { x.summary = x.summary.replace('December 8, 2026', 'December 9, 2026'); });
ok('a wrong date (December 9) is blocked', blocks(v, 'figures').some((i) => /December 9, 2026/.test(i.detail)));
v = t((x) => { x.summary = x.summary.replace('$4,850', '$5,000'); });
ok('a wrong amount ($5,000) is blocked', blocks(v, 'figures').some((i) => /\$5,000/.test(i.detail)));
v = t((x) => { x.summary = x.summary.replace('1:30 PM', '2:30 PM'); });
ok('a wrong time (2:30 PM) is blocked', blocks(v, 'figures').some((i) => /2:30 PM/.test(i.detail)));
v = t((x) => { x.summary += ' Judge Alan Pierce will hear it.'; });
ok('a name that is not in the record is blocked', blocks(v, 'names').some((i) => /"Alan Pierce"/.test(i.detail)), v.issues);
v = t((x) => { x.actions[1].text += ' Ms. Okafor will be there.'; });
ok('so is a title before an unknown surname', blocks(v, 'names').some((i) => /"Okafor"/.test(i.detail)), v.issues);
v = t((x) => { x.actions[0].text = 'You will win if you show the repair invoice.'; });
ok('"you will win" is blocked as legal advice', blocks(v, 'advice').length === 1);
v = t((x) => { x.caveats = 'Dates come from the docket.'; });
ok('caveats that drop "not legal advice" are blocked', blocks(v, 'advice').some((i) => /caveats/.test(i.detail)));
v = t((x) => { x.next = x.next.slice(0, 1); });
ok('leaving out the trial date is blocked', blocks(v, 'complete').some((i) => /trial on December 8, 2026 \(D9\) is missing/.test(i.detail)));
v = t((x) => { x.next[0].daysUntil = 25; });
ok('a wrong countdown (25 days for 24) is blocked', blocks(v, 'complete').some((i) => /says 25 days; the record gives 24/.test(i.detail)));
v = t((x) => { x.next.push({ date: 'October 21, 2026', time: '9:00 AM', what: 'Pretrial conference', where: 'Courtroom 3B', daysUntil: -6, ref: 'D6' }); });
ok('a date that has passed listed as "next" is blocked', blocks(v, 'complete').some((i) => /already passed/.test(i.detail)));
v = t((x) => { x.actions[2].ref = 'D99'; });
ok('an action pointing at an entry that does not exist is blocked', blocks(v, 'actions').length === 1);
v = t((x) => { x.summary += ' A continuance is possible.'; });
ok('a legal term with no glossary entry is blocked', blocks(v, 'jargon').some((i) => /"continuance"/.test(i.detail)));
v = t((x) => { x.summary = 'Notwithstanding the aforementioned procedural determinations, the adjudicative authority subsequently promulgated comprehensive mediation requirements contemplating substantive interlocutory negotiations between litigants.'; });
ok('writing above grade 8 is blocked for the public', blocks(v, 'reading').length === 1 && v.grade > 8, v.grade);
ok('the same text only warns on the staff version', (() => { const x = clone(staff); x.summary = 'Notwithstanding the aforementioned procedural determinations, the adjudicative authority subsequently promulgated comprehensive mediation requirements.'; const w = C.verify(x, SC, AS_OF, { audience: 'staff' }); return !blocks(w, 'reading').length && w.issues.some((i) => i.check === 'reading' && i.severity === 'warn'); })());
v = C.verify({ headline: 'x' }, SC, AS_OF);
ok('a reply missing fields is blocked on shape before anything else', !v.ok && blocks(v, 'shape').length >= 5);
ok('a reply that is not an object is blocked', !C.verify([1, 2], SC, AS_OF).ok);
v = t((x) => { x.timeline[0].text = 'The case was filed on 08/15/2026'; });
ok('numeric dates are traced too (08/15/2026 is not in the record)', blocks(v, 'figures').some((i) => /08\/15\/2026/.test(i.detail)));
v = t((x) => { x.summary += ' The case has been open 74 days.'; });
ok('a day count the record gives (74 days open) passes', v.ok);
v = t((x) => { x.summary += ' The case has been open 80 days.'; });
ok('one it does not (80 days) is blocked', blocks(v, 'figures').some((i) => /80 days/.test(i.detail)));

section('6. The Claude request a delivered build sends');
const q = C.request(SC, AS_OF);
ok('model claude-opus-5-5 with server-side fallback on', q.body.model === 'claude-opus-5-5' && q.body.betas.includes('server-side-fallback-2026-07-01') && q.body.fallbacks === 'default');
ok('structured output: output_config.format is the report JSON schema, effort low', q.body.output_config.format.type === 'json_schema' && q.body.output_config.format.schema === C.SCHEMA && q.body.output_config.effort === 'low');
ok('no temperature or other removed sampling settings', !('temperature' in q.body) && !('top_p' in q.body) && !('thinking' in q.body));
ok('the system prompt carries the rules the checks enforce', /grade 8 or lower/.test(q.body.system) && /not give legal advice/.test(q.body.system) && /cite the docket entry/.test(q.body.system));
ok('the input carries the docket, the derived dates and the record problems', q.input.docket.length === 9 && q.input.derived.upcoming.length === 2 && Array.isArray(q.input.recordProblems));
ok('cost per report at list price is about 3 cents', q.cost > 0.02 && q.cost < 0.05, q.cost);
ok('the staff request asks for grade 14', /grade 14 or lower/.test(C.request(SC, AS_OF, { audience: 'staff' }).body.system));

section('7. The end-user page and the reading-level formula');
const html = C.renderHtml(r, SC);
ok('the report renders its sections with countdowns', /What happens next/.test(html) && /in 24 days/.test(html) && /Words you will see/.test(html));
const evil = clone(r); evil.summary = '<script>alert(1)</script>';
ok('text is escaped, never run', !/<script>/.test(C.renderHtml(evil, SC)) && /&lt;script&gt;/.test(C.renderHtml(evil, SC)));
ok('short plain sentences score low, dense ones high', C.grade('The judge set a date. You can go.') < 3 && C.grade('Interlocutory adjudication necessitates comprehensive procedural documentation.') > 14);
ok('dates and money format the way people read them', C.fmtDate('2026-12-08') === 'December 8, 2026' && C.fmtTime('13:30') === '1:30 PM' && C.fmtTime('00:05') === '12:05 AM' && C.fmtMoney(3912.4) === '$3,912.40' && C.fmtMoney(4850) === '$4,850');

console.log('\n' + (passed + failed) + ' checks: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
