// src/caseReport.js: turns internal court-record data into a plain-English, actionable report, and checks
// any report (the model's or a person's) against the record before an end user sees it. The page and the
// tests load this same file.
//   facts(record, asOf)            -> what the record says: stage, dated events, amounts, problems
//   draft(record, asOf, opts)      -> the structured report (in the demo this stands in for Claude's reply)
//   verify(report, record, asOf)   -> every date, time, amount, name and claim traced back to the record
//   request(record, asOf, opts)    -> the exact Claude API request a delivered build sends
//   renderHtml(report, record)     -> the end-user report
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaseReport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- what each docket code means (plain English, the stage it moves the case to, the term it uses) ----------
  const DICT = {
    'CMPL': { plain: 'The case was filed (the complaint)', stage: 'Filed', term: 'complaint' },
    'FEE': { plain: 'The filing fee was paid', stage: null },
    'SUMS ISS': { plain: 'The court issued a summons to the other side', stage: 'Filed', term: 'summons' },
    'SRV RET': { plain: 'Proof of service was filed: the other side was officially given the papers', stage: 'Served', term: 'service' },
    'ANS': { plain: 'The other side filed an answer', stage: 'Answered', term: 'answer' },
    'NTC HRG': { plain: 'A hearing was scheduled', stage: null, term: 'hearing' },
    'PTC HELD': { plain: 'The pretrial conference took place', stage: 'Pretrial', term: 'pretrial conference' },
    'ORD MED': { plain: 'The judge sent the case to mediation', stage: 'Mediation', term: 'mediation' },
    'NTC TRL': { plain: 'A trial date was set', stage: null, term: 'trial' },
    'MTN CONT': { plain: 'A request was made to move a court date', stage: null, term: 'continuance' },
    'ORD CONT': { plain: 'The judge moved a court date', stage: null, term: 'continuance' },
    'MED AGR': { plain: 'Mediation ended in an agreement', stage: 'Settled', term: 'mediation' },
    'MED IMP': { plain: 'Mediation ended without an agreement', stage: 'Trial', term: 'mediation' },
    'JDGMT': { plain: 'The judge entered a judgment (a final decision)', stage: 'Judgment', term: 'judgment' },
    'DFLT': { plain: 'A default was entered because the other side did not respond', stage: 'Judgment', term: 'default' },
    'DISM': { plain: 'The case was dismissed', stage: 'Closed', term: 'dismissed' },
    'SATIS': { plain: 'The judgment was paid', stage: 'Closed', term: 'judgment' },
    'PET': { plain: 'The case was opened with a petition', stage: 'Opened', term: 'petition' },
    'LTRS ADM': { plain: 'The court appointed a personal representative to manage the estate', stage: 'Representative appointed', term: 'letters of administration' },
    'NTC CRED': { plain: 'A notice to creditors was published, so anyone owed money can file a claim', stage: 'Creditor period', term: 'notice to creditors' },
    'INV': { plain: 'An inventory of what the estate owns was filed', stage: 'Inventory filed', term: 'inventory' },
    'CLM': { plain: 'A claim was filed saying the estate owes money', stage: 'Claims', term: 'claim' },
    'ORD DISCH': { plain: 'The court closed the estate', stage: 'Closed', term: 'discharge' },
  };
  const STAGES = {
    'small-claims': ['Filed', 'Served', 'Answered', 'Pretrial', 'Mediation', 'Trial', 'Settled', 'Judgment', 'Closed'],
    'probate': ['Opened', 'Representative appointed', 'Creditor period', 'Inventory filed', 'Claims', 'Closed'],
  };
  const STAGE_PLAIN = {
    Filed: 'The case has been filed and the other side is being notified.',
    Served: 'The other side has been officially notified and can now respond.',
    Answered: 'The other side has responded, and the court is planning the next steps.',
    Pretrial: 'The judge has met with both sides to plan the case.',
    Mediation: 'The judge has sent the case to mediation, a meeting where both sides try to agree with help from a neutral person.',
    Trial: 'The case is heading to trial.',
    Settled: 'The two sides reached an agreement.',
    Judgment: 'The judge has made a final decision.',
    Closed: 'The case is closed.',
    Opened: 'The estate case has been opened.',
    'Representative appointed': 'The court has appointed someone to manage the estate.',
    'Creditor period': 'The estate is in the period when anyone owed money can file a claim.',
    'Inventory filed': 'A list of what the estate owns has been filed.',
    Claims: 'A claim against the estate is being dealt with.',
  };
  // Legal words an end user may not know, with the plain meaning the glossary must give.
  const JARGON = {
    'small claims': 'A simpler court process for smaller money disputes.',
    'complaint': 'The paper that starts a case and says what the person filing wants.',
    'summons': 'The formal notice telling the other side they are being sued.',
    'service': 'Officially handing the court papers to the other side.',
    'answer': "The other side's written response to the complaint.",
    'pretrial conference': 'A short meeting with the judge to plan the rest of the case.',
    'mediation': 'A meeting where both sides try to reach an agreement with help from a neutral person.',
    'trial': 'The hearing where the judge listens to both sides and decides.',
    'judgment': "The judge's final decision.",
    'probate': 'The court process for settling the estate of a person who has died.',
    'personal representative': 'The person the court appoints to manage the estate.',
    'estate': 'Everything a person owned, and owed, when they died.',
    'petition': 'The paper that asks the court to open a case.',
    'letters of administration': 'The court paper that gives the personal representative authority to act.',
    'notice to creditors': 'A public notice telling anyone owed money by the estate to file a claim.',
    'inventory': 'A list of what the estate owns and what it is worth.',
    'continuance': 'Moving a court date to a later day.',
    'default': 'A ruling against a side that did not respond.',
    'hearing': 'A set time when the judge hears from the sides on one issue.',
    'docket': "The court's list of everything filed and done in a case.",
  };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DEFAULTS = { audience: 'public', readingTarget: { public: 8, staff: 14 }, maxSummarySentences: 5 };

  // ---------- small helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function validISO(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return MONTHS[m - 1] + ' ' + d + ', ' + y; };
  const fmtTime = (hm) => { const [h, m] = hm.split(':').map(Number); return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); };
  const fmtMoney = (v) => '$' + (Math.round(v * 100) % 100 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(v).toLocaleString('en-US'));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const mdy = (m, d, y) => y + '-' + m + '-' + d;
  const room = (kind, id) => (kind === 'CTRM' ? 'Courtroom ' : 'Room ') + id;

  // ---------- facts: what the record says ----------
  function facts(record, asOf) {
    const problems = [], entries = [], seen = new Set();
    if (!validISO(asOf)) problems.push('report date ' + asOf + ' is not a real date');
    (record.docket || []).forEach((e, i) => {
      const at = 'entry ' + (e && e.id ? e.id : '#' + (i + 1));
      if (!e || typeof e !== 'object') return problems.push(at + ': not an entry, left out');
      if (!validISO(e.date)) return problems.push(at + ': impossible date "' + e.date + '", left out' + (/SET|BY|DUE/.test(e.text || '') ? '; the court date it mentions is not shown until the date is fixed' : ''));
      if (validISO(asOf) && e.date > asOf) return problems.push(at + ': dated ' + e.date + ', after the report date, left out');
      if (!String(e.text || '').trim()) return problems.push(at + ': no text, left out');
      let id = String(e.id || 'E' + (i + 1));
      if (seen.has(id)) { problems.push(at + ': duplicate id, renamed ' + id + '-' + (i + 1)); id = id + '-' + (i + 1); }
      seen.add(id);
      const code = String(e.code || '').trim().toUpperCase(), known = DICT[code];
      if (!known) problems.push(at + ': code "' + (code || 'blank') + '" is not recognized; shown as written');
      entries.push({ id, date: e.date, code, text: String(e.text).trim(), known: !!known, plain: known ? known.plain : 'Court entry (code not recognized): ' + cap(String(e.text).trim()), stage: known ? known.stage : null, term: known ? known.term : null, order: i });
    });
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
    const stages = STAGES[record.type] || STAGES['small-claims'];
    let stageIx = -1;
    entries.forEach((e) => { const ix = stages.indexOf(e.stage); if (ix > stageIx) stageIx = ix; });
    const events = [], dates = new Set([record.filed, asOf].filter(Boolean)), times = new Set(), money = [], numbers = new Set();
    entries.forEach((e) => {
      dates.add(e.date);
      let m;
      const set = /SET (\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?(?: (CTRM|RM) ([\w-]+))?/.exec(e.text);
      if (set) {
        const date = mdy(set[1], set[2], set[3]);
        if (validISO(date)) {
          const before = e.text.slice(0, set.index).replace(/^(NOTICE OF|ORDER (CONTINUING|RESETTING|SETTING))\s+/, '').replace(/\s*-\s*$/, '').trim();
          const what = e.code === 'NTC TRL' || /^TRIAL$/.test(before) ? 'Trial' : before ? cap(before) : 'Hearing';
          const time = set[4] ? set[4] + ':' + set[5] : null;
          events.push({ ref: e.id, kind: 'date', date, time, room: set[6] ? room(set[6], set[7]) : null, what, moves: e.code === 'ORD CONT' });
          if (time) times.add(time);
        } else problems.push('entry ' + e.id + ': the date it sets (' + set[1] + '/' + set[2] + '/' + set[3] + ') is impossible');
      }
      const by = /(COMPLETE BY|DUE) (\d{2})\/(\d{2})\/(\d{4})/.exec(e.text);
      if (by) {
        const date = mdy(by[2], by[3], by[4]);
        if (validISO(date)) events.push({ ref: e.id, kind: 'deadline', date, time: null, room: null, what: e.code === 'ORD MED' ? 'Mediation must be finished' : 'Deadline' });
      }
      const re = /(\d{2})\/(\d{2})\/(\d{4})/g;
      while ((m = re.exec(e.text))) { const d = mdy(m[1], m[2], m[3]); if (validISO(d)) dates.add(d); }
      const mr = /\$([\d,]+(?:\.\d{2})?)/g;
      while ((m = mr.exec(e.text))) money.push({ value: parseFloat(m[1].replace(/,/g, '')), ref: e.id });
      (e.text.match(/\d+/g) || []).forEach((n) => numbers.add(String(+n)));
    });
    if (record.claim && typeof record.claim.amount === 'number') money.push({ value: record.claim.amount, ref: 'claim' });
    // A continuance order that sets a new date for the same event replaces the earlier date.
    events.forEach((ev, i) => {
      if (!ev.moves) return;
      events.slice(0, i).forEach((old) => { if (old.what === ev.what && !old.superseded) { old.superseded = true; old.movedTo = ev.date; } });
    });
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    events.forEach((ev) => { ev.daysUntil = validISO(asOf) ? days(asOf, ev.date) : null; ev.past = ev.daysUntil !== null && ev.daysUntil < 0; });
    const upcoming = events.filter((ev) => !ev.past && !ev.superseded);
    return {
      id: record.id, title: record.title, type: record.type, court: record.court, subject: record.subject, asOf,
      filed: record.filed, daysOpen: validISO(record.filed) && validISO(asOf) ? days(record.filed, asOf) : null,
      parties: (record.parties || []).filter((p) => p && p.name), stages, stage: stageIx >= 0 ? stages[stageIx] : 'Filed', stageIndex: Math.max(0, stageIx),
      entries, events, upcoming, money, dates: [...dates].filter(validISO), times: [...times], numbers: [...numbers], problems,
    };
  }

  // ---------- draft: the structured report (the shape Claude must return) ----------
  const known = (e) => e.known;
  const party = (f, role) => (f.parties.find((p) => p.role.toLowerCase() === role.toLowerCase()) || {}).name;
  function draft(record, asOf, opts) {
    const o = Object.assign({}, DEFAULTS, opts), f = facts(record, asOf), staff = o.audience === 'staff';
    const when = (ev) => fmtDate(ev.date) + (ev.time ? ' at ' + fmtTime(ev.time) : '');
    const s = [];
    if (f.type === 'probate') {
      s.push('This is a probate case about ' + (f.subject || 'an estate') + ', opened on ' + fmtDate(f.filed) + '.');
      const appt = f.entries.find((e) => e.code === 'LTRS ADM'), pr = party(f, 'Personal representative');
      if (appt && pr) s.push(pr + ' was appointed as the personal representative on ' + fmtDate(appt.date) + '.');
      const clm = f.entries.find((e) => e.code === 'CLM'), cl = party(f, 'Claimant'), amt = clm && f.money.find((m) => m.ref === clm.id);
      if (clm && cl && amt) s.push(cl + ' filed a claim for ' + fmtMoney(amt.value) + ' on ' + fmtDate(clm.date) + '.');
    } else {
      s.push('This is a small claims case about ' + (f.subject || 'a money dispute') + ', filed on ' + fmtDate(f.filed) + '.');
      const pl = party(f, 'Plaintiff'), df = party(f, 'Defendant');
      if (pl && df && record.claim) s.push(pl + ' is asking ' + df + ' for ' + fmtMoney(record.claim.amount) + '.');
      s.push(STAGE_PLAIN[f.stage]);
    }
    if (f.upcoming.length) {
      s.push('The next date is ' + f.upcoming[0].what.toLowerCase().replace(/^mediation must be finished$/, 'the mediation deadline') + ' on ' + when(f.upcoming[0]) + '.');
      if (f.upcoming[1]) s.push('After that, ' + f.upcoming[1].what.toLowerCase().replace(/^trial$/, 'the trial') + ' is set for ' + when(f.upcoming[1]) + '.');
    } else s.push('No future court dates are on the record as of ' + fmtDate(asOf) + '.');
    const next = f.upcoming.map((ev) => ({ date: fmtDate(ev.date), time: ev.time ? fmtTime(ev.time) : '', what: ev.what, where: ev.room || '', daysUntil: ev.daysUntil, ref: ev.ref }));
    const actions = [];
    f.upcoming.forEach((ev) => {
      if (ev.kind === 'deadline') actions.push({ text: (staff ? 'Calendar the deadline: ' : 'Put ' + fmtDate(ev.date) + ' on your calendar: ') + (staff ? fmtDate(ev.date) + ', ' + ev.what.toLowerCase() : ev.what.toLowerCase().replace(/^mediation must be finished$/, 'mediation must be finished by then')) + '.', ref: ev.ref });
      else actions.push({ text: (staff ? 'Calendar: ' + ev.what.toLowerCase() + ', ' : 'If you are part of this case, plan to be at the ' + ev.what.toLowerCase() + ' on ') + when(ev) + (ev.room ? ' in ' + ev.room : '') + '.', ref: ev.ref });
    });
    const filedDoc = [...f.entries].reverse().find((e) => /^(ANS|INV|CLM|CMPL|PET)$/.test(e.code));
    if (filedDoc) actions.push({ text: staff ? 'Copies on request: ' + DICT[filedDoc.code].plain.toLowerCase() + ' (' + fmtDate(filedDoc.date) + ').' : "Ask the clerk's office for copies of any filing listed here, such as the one from " + fmtDate(filedDoc.date) + '.', ref: filedDoc.id });
    if (!staff) actions.push({ text: "For advice about your own situation, contact a lawyer or the court's self-help center.", ref: 'general' });
    const timeline = f.entries.map((e) => {
      const amt = f.money.find((m) => m.ref === e.id), ev = f.events.find((x) => x.ref === e.id);
      // Dates the entry itself mentions ("DEF SERVED 08/29/2026") are part of what happened.
      const said = (e.text.match(/SERVED (\d{2})\/(\d{2})\/(\d{4})/) || []);
      let detail = '';
      if (ev && ev.kind === 'deadline') detail = '; it must be finished by ' + fmtDate(ev.date);
      else if (ev) detail = ': ' + (e.code === 'NTC TRL' ? '' : ev.what.toLowerCase() + ' on ') + when(ev) + (ev.room ? ' in ' + ev.room : '');
      else if (said[0] && known(e)) detail = ' on ' + fmtDate(mdy(said[1], said[2], said[3]));
      return { date: fmtDate(e.date), text: e.plain + detail + (amt ? ' (' + fmtMoney(amt.value) + ')' : '') + (staff ? ' [' + (e.code || 'no code') + ']' : ''), ref: e.id };
    });
    const report = {
      headline: f.title + ': ' + (f.upcoming.length ? f.stage.toLowerCase() + ', next date ' + fmtDate(f.upcoming[0].date) : f.stage.toLowerCase()),
      status: { stage: f.stage, plain: STAGE_PLAIN[f.stage] || f.stage },
      summary: s.join(' '),
      next, actions, timeline, glossary: [],
      caveats: 'This report explains the court record in plain English. It is not legal advice. Dates come from the docket as of ' + fmtDate(asOf) + '; check with the clerk before relying on them.' +
        (f.problems.length ? ' ' + f.problems.length + ' docket ' + (f.problems.length > 1 ? 'entries were' : 'entry was') + ' not shown in full because of a problem in the record.' : ''),
    };
    if (!staff) report.glossary = termsUsed(report).map((t) => ({ term: t, plain: JARGON[t] }));
    return report;
  }
  function textOf(report, fields) {
    const parts = [];
    const add = (path, v) => { if (typeof v === 'string') parts.push({ path, text: v }); };
    (fields || ['headline', 'summary', 'next', 'actions', 'timeline', 'caveats', 'status']).forEach((k) => {
      const v = report[k];
      if (typeof v === 'string') add(k, v);
      else if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === 'string') add(k + '[' + i + ']', x); else if (x && typeof x === 'object') Object.keys(x).forEach((kk) => { if (kk !== 'ref') add(k + '[' + i + '].' + kk, x[kk]); }); });
      else if (v && typeof v === 'object') Object.keys(v).forEach((kk) => add(k + '.' + kk, v[kk]));
    });
    return parts;
  }
  function termsUsed(report) {
    const t = textOf(report, ['summary', 'next', 'actions', 'timeline']).map((p) => p.text).join(' ').toLowerCase();
    return Object.keys(JARGON).filter((term) => new RegExp('\\b' + term.replace(/ /g, '\\s+') + 's?\\b').test(t));
  }

  // ---------- reading level (Flesch-Kincaid grade) ----------
  function syllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 0;
    if (w.length <= 3) return 1;
    const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
  }
  function grade(text) {
    const sentences = String(text).split(/[.!?]+(?:\s|$)/).filter((x) => x.trim().length > 0).length || 1;
    const words = String(text).replace(/\$[\d,.]+/g, 'money').match(/[A-Za-z][A-Za-z'-]*|\d[\d,:.]*/g) || [];
    if (!words.length) return 0;
    const syl = words.reduce((a, w) => a + (/^\d/.test(w) ? 1 : syllables(w)), 0);
    return Math.round((0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59) * 10) / 10;
  }

  // ---------- verify: nothing reaches an end user that the record does not support ----------
  const ADVICE = [/\byou (will|are going to|would) (win|lose)\b/i, /\bguarantee/i, /\byou (should|must|need to) (sue|settle|plead|appeal|sign|accept|refuse)\b/i, /\bwe (recommend|advise)\b/i, /\byour best (option|move|strategy)\b/i, /\blegal advice\b/i];
  const COMMONCAPS = new Set('The This That These Those If For Put Ask Note After Before When Then It A An In On At By Of And Or To Your You Courtroom Room Court Clerk County Division Circuit Small Claims Probate Estate Harbor LLC Inc PM AM Mediation Trial Hearing Answer Summons Calendar Copies Proof Filing No Next Plan Today Self-help'.split(' ').concat(MONTHS, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']));
  function verify(report, record, asOf, opts) {
    const o = Object.assign({}, DEFAULTS, opts), f = facts(record, asOf), issues = [];
    let figures = 0, traced = 0, g = null;
    const add = (severity, check, detail, field) => issues.push({ severity, check, detail, field: field || '' });
    // 1. shape
    const shape = [['headline', 'string'], ['summary', 'string'], ['next', 'array'], ['actions', 'array'], ['timeline', 'array'], ['glossary', 'array'], ['caveats', 'string']];
    if (!report || typeof report !== 'object' || Array.isArray(report)) { add('block', 'shape', 'the reply is not a report object'); return finish(); }
    shape.forEach(([k, t]) => { const v = report[k]; if (t === 'array' ? !Array.isArray(v) : typeof v !== t) add('block', 'shape', '"' + k + '" is missing or not a ' + t, k); });
    if (issues.length) return finish();
    report.actions.forEach((a, i) => { if (!a || typeof a.text !== 'string' || typeof a.ref !== 'string') add('block', 'shape', 'actions[' + i + '] needs text and ref', 'actions[' + i + ']'); });
    report.next.forEach((n, i) => { if (!n || typeof n.date !== 'string' || typeof n.what !== 'string') add('block', 'shape', 'next[' + i + '] needs date and what', 'next[' + i + ']'); });
    if (issues.length) return finish();
    const parts = textOf(report);
    // 2. every figure traced to the record
    // Counts the record itself gives (entries, problems, upcoming dates) are traceable too.
    const counts = [f.entries.length, f.problems.length, f.upcoming.length].map(String);
    const dateSet = new Set(f.dates), moneySet = f.money.map((m) => m.value), dayCounts = new Set([f.daysOpen].concat(f.events.map((e) => Math.abs(e.daysUntil))).filter((x) => x !== null));
    parts.forEach((p) => {
      const t = p.text, taken = [];
      const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
      const hit = (m, ok, what) => { if (!free(m.index, m.index + m[0].length)) return; taken.push([m.index, m.index + m[0].length]); figures++; if (ok) traced++; else add('block', 'figures', '"' + m[0] + '" ' + what, p.path); };
      let m;
      const reLong = new RegExp('\\b(' + MONTHS.join('|') + ') (\\d{1,2})(?:, (\\d{4}))?', 'g');
      while ((m = reLong.exec(t))) {
        const mm = String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0'), dd = String(m[2]).padStart(2, '0');
        const ok = m[3] ? dateSet.has(m[3] + '-' + mm + '-' + dd) : [...dateSet].some((d) => d.slice(5) === mm + '-' + dd);
        hit(m, ok, 'is not a date in the record');
      }
      const reNum = /\b(\d{2})\/(\d{2})\/(\d{4})\b/g;
      while ((m = reNum.exec(t))) hit(m, dateSet.has(m[3] + '-' + m[1] + '-' + m[2]), 'is not a date in the record');
      const reTime = /\b(\d{1,2}):(\d{2})\s?(AM|PM)\b/gi;
      while ((m = reTime.exec(t))) { let h = +m[1] % 12; if (m[3].toUpperCase() === 'PM') h += 12; hit(m, f.times.includes(String(h).padStart(2, '0') + ':' + m[2]), 'is not a time in the record'); }
      const reMoney = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
      while ((m = reMoney.exec(t))) { const v = parseFloat(m[1].replace(/,/g, '')); hit(m, moneySet.some((x) => Math.abs(x - v) < 0.005), 'is not an amount in the record'); }
      const reDays = /\b(\d+) days?\b/g;
      while ((m = reDays.exec(t))) hit(m, dayCounts.has(+m[1]), 'is not a day count the record gives (days open, or days to a set date)');
      const reBare = /\b\d[\d,.]*\b/g;
      while ((m = reBare.exec(t))) { if (/^\d{4}$/.test(m[0]) && dateSet.size && [...dateSet].some((d) => d.startsWith(m[0]))) { hit(m, true); continue; } hit(m, f.numbers.includes(String(+m[0].replace(/,/g, ''))) || counts.includes(String(+m[0])), 'is not a number in the record'); }
    });
    // 3. names: a capitalised pair that the record never mentions
    const vocab = new Set(), recText = [record.title, record.court].concat(f.parties.map((x) => x.name), f.entries.map((e) => e.text)).join(' ');
    (recText.match(/[A-Za-z][A-Za-z.'-]*/g) || []).forEach((w) => vocab.add(w.toLowerCase().replace(/[.']$/, '')));
    // A run of capitalised words with two or more the record never uses, or a title ("Judge", "Ms.") before
    // an unknown word, is treated as a name the record does not support.
    const TITLES = new Set(['Judge', 'Mr', 'Ms', 'Mrs', 'Dr', 'Attorney', 'Officer']);
    parts.filter((p) => !/^caveats/.test(p.path)).forEach((p) => {
      const re = /\b[A-Z][a-z]+\.?(?:\s+[A-Z][a-z]+(?:[-'][A-Za-z]+)?\.?)+/g;
      let m;
      while ((m = re.exec(p.text))) {
        const ws = m[0].split(/\s+/).map((w) => w.replace(/\.$/, ''));
        const unknown = ws.filter((w) => !COMMONCAPS.has(w) && !TITLES.has(w) && !vocab.has(w.toLowerCase()));
        const titled = ws.some((w, i) => TITLES.has(w) && ws[i + 1] && unknown.includes(ws[i + 1]));
        if (unknown.length >= 2 || titled) add('block', 'names', '"' + unknown.join(' ') + '" is not a name in the record', p.path);
      }
    });
    // 4. no legal advice outside the caveats
    parts.filter((p) => !/^caveats/.test(p.path)).forEach((p) => ADVICE.forEach((re) => { const m = re.exec(p.text); if (m) add('block', 'advice', '"' + m[0] + '" reads as legal advice; describe what the record shows instead', p.path); }));
    if (!/not legal advice/i.test(report.caveats)) add('block', 'advice', 'the caveats must say the report is not legal advice', 'caveats');
    // 5. nothing missed, nothing stale
    f.upcoming.forEach((ev) => { if (!report.next.some((n) => n.date === fmtDate(ev.date))) add('block', 'complete', 'the ' + ev.what.toLowerCase() + ' on ' + fmtDate(ev.date) + ' (' + ev.ref + ') is missing from "What happens next"', 'next'); });
    report.next.forEach((n, i) => {
      const ev = f.events.find((e) => fmtDate(e.date) === n.date);
      if (ev && ev.past) add('block', 'complete', n.date + ' has already passed but is listed as next', 'next[' + i + ']');
      if (ev && ev.superseded && !f.upcoming.some((u) => fmtDate(u.date) === n.date)) add('block', 'complete', n.date + ' was moved to ' + fmtDate(ev.movedTo) + ' and is no longer a court date', 'next[' + i + ']');
      if (ev && typeof n.daysUntil === 'number' && n.daysUntil !== ev.daysUntil) add('block', 'complete', 'the countdown to ' + n.date + ' says ' + n.daysUntil + ' days; the record gives ' + ev.daysUntil, 'next[' + i + '].daysUntil');
    });
    // 6. every action points at a real entry
    const ids = new Set(f.entries.map((e) => e.id).concat(['general']));
    report.actions.forEach((a, i) => { if (!ids.has(a.ref)) add('block', 'actions', 'action ' + (i + 1) + ' points at "' + a.ref + '", which is not an entry in the record', 'actions[' + i + ']'); });
    // 7. plain English for the public: reading level and every legal term explained
    const target = o.readingTarget[o.audience] || 8;
    g = grade([report.summary].concat(report.actions.map((a) => a.text)).join(' '));
    if (g > target) add(o.audience === 'public' ? 'block' : 'warn', 'reading', 'reads at grade ' + g + '; the target is ' + target + ' or lower', 'summary');
    if (o.audience === 'public') {
      const glossed = new Set(report.glossary.map((x) => String(x && x.term || '').toLowerCase()));
      termsUsed(report).forEach((t) => { if (!glossed.has(t)) add('block', 'jargon', '"' + t + '" is used without being explained in "Words you will see"', 'glossary'); });
      const sentences = report.summary.split(/(?<=[.!?])\s+/).filter(Boolean).length;
      if (sentences > o.maxSummarySentences) add('warn', 'reading', 'the summary has ' + sentences + ' sentences; keep it to ' + o.maxSummarySentences, 'summary');
    }
    return finish();
    function finish() {
      const CHECKS = [['shape', 'Matches the report schema'], ['figures', 'Every date, time and amount traced to the record'], ['names', 'Only names that are in the record'], ['advice', 'No legal advice'], ['complete', 'Every upcoming date included, none stale'], ['actions', 'Every action points at a real entry'], ['reading', 'Reads at the target grade'], ['jargon', 'Every legal term explained']];
      const checks = CHECKS.map(([id, label]) => ({ id, label, ok: !issues.some((i) => i.check === id && i.severity === 'block'), warn: issues.some((i) => i.check === id && i.severity === 'warn') }));
      return { ok: !issues.some((i) => i.severity === 'block'), issues, checks, figures, traced, grade: typeof g === 'number' ? g : null, problems: f.problems };
    }
  }

  // ---------- the Claude request a delivered build sends ----------
  const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['headline', 'status', 'summary', 'next', 'actions', 'timeline', 'glossary', 'caveats'],
    properties: {
      headline: { type: 'string' },
      status: { type: 'object', additionalProperties: false, required: ['stage', 'plain'], properties: { stage: { type: 'string' }, plain: { type: 'string' } } },
      summary: { type: 'string' },
      next: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['date', 'time', 'what', 'where', 'daysUntil', 'ref'], properties: { date: { type: 'string' }, time: { type: 'string' }, what: { type: 'string' }, where: { type: 'string' }, daysUntil: { type: 'integer' }, ref: { type: 'string' } } } },
      actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'ref'], properties: { text: { type: 'string' }, ref: { type: 'string' } } } },
      timeline: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['date', 'text', 'ref'], properties: { date: { type: 'string' }, text: { type: 'string' }, ref: { type: 'string' } } } },
      glossary: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['term', 'plain'], properties: { term: { type: 'string' }, plain: { type: 'string' } } } },
      caveats: { type: 'string' },
    },
  };
  function systemPrompt(audience, target) {
    return [
      audience === 'staff' ? 'You write case status summaries for court-records staff.' : 'You write plain-English case status reports for members of the public who look up court records.',
      'Use only the facts in the input. Every date, time, amount and name you write must appear in the input; never estimate or fill a gap.',
      'Write the summary at grade ' + target + ' or lower: short sentences, everyday words. Put every legal term you use in the glossary with a one-line meaning.',
      'Describe what the record shows. Do not give legal advice or predict outcomes; point people to the clerk, a lawyer or the self-help center for advice.',
      'Every action must cite the docket entry it comes from (its id), or "general". List every upcoming date in "next".',
      'Return only JSON that matches the schema.',
    ].join('\n');
  }
  // Anthropic list price for Claude Opus 5.5 per million tokens (read 27 Oct 2026): $4 input, $20 output.
  const PRICE = { model: 'claude-opus-5-5', in: 4, out: 20 };
  function request(record, asOf, opts) {
    const o = Object.assign({}, DEFAULTS, opts), f = facts(record, asOf), target = o.readingTarget[o.audience] || 8;
    const input = {
      asOf, audience: o.audience, readingTarget: target,
      case: { id: record.id, title: record.title, court: record.court, type: record.type, subject: record.subject, filed: record.filed, parties: f.parties, claim: record.claim || null },
      docket: f.entries.map((e) => ({ id: e.id, date: e.date, code: e.code, text: e.text, meaning: e.known ? e.plain : null })),
      derived: { stage: f.stage, daysOpen: f.daysOpen, upcoming: f.upcoming.map((e) => ({ ref: e.ref, date: e.date, time: e.time, where: e.room, what: e.what, daysUntil: e.daysUntil })) },
      recordProblems: f.problems,
    };
    const body = {
      model: PRICE.model, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: systemPrompt(o.audience, target),
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    };
    // Rough token estimate (about 4 characters per token) for the cost line; the delivered build logs the real usage.
    const tokensIn = Math.ceil((body.system.length + JSON.stringify(SCHEMA).length + body.messages[0].content.length) / 4) + 40;
    const tokensOut = Math.ceil(JSON.stringify(draft(record, asOf, o)).length / 4) + 600;
    const cost = Math.round((tokensIn * PRICE.in + tokensOut * PRICE.out) / 1e6 * 10000) / 10000;
    return { body, input, tokensIn, tokensOut, cost };
  }

  // ---------- the end-user report ----------
  function renderHtml(report, record) {
    const r = report;
    const g = (r.glossary || []).map((x) => '<div class="gl"><b>' + esc(x.term) + '</b><span>' + esc(x.plain) + '</span></div>').join('');
    return '<article class="rep">' +
      '<header class="rep-h"><div class="rep-court">' + esc(record.court || '') + ' · Case ' + esc(record.id || '') + '</div><h3>' + esc(record.title || '') + '</h3>' +
      '<span class="pill">' + esc(r.status && r.status.stage || '') + '</span></header>' +
      '<p class="rep-sum">' + esc(r.summary) + '</p>' +
      (r.next.length ? '<h4>What happens next</h4><div class="nexts">' + r.next.map((n) => '<div class="nx"><div class="nx-d">' + esc(n.date) + (n.time ? '<small>' + esc(n.time) + '</small>' : '') + '</div><div><b>' + esc(n.what) + '</b>' + (n.where ? '<span>' + esc(n.where) + '</span>' : '') + (typeof n.daysUntil === 'number' ? '<span class="cd">in ' + n.daysUntil + ' day' + (n.daysUntil === 1 ? '' : 's') + '</span>' : '') + '</div></div>').join('') + '</div>' : '') +
      '<h4>What you can do</h4><ul class="acts">' + r.actions.map((a) => '<li>' + esc(a.text) + '</li>').join('') + '</ul>' +
      '<h4>What has happened so far</h4><ol class="tl">' + r.timeline.map((t) => '<li><span class="tl-d">' + esc(t.date) + '</span>' + esc(t.text) + '</li>').join('') + '</ol>' +
      (g ? '<h4>Words you will see</h4><div class="gls">' + g + '</div>' : '') +
      '<p class="cav">' + esc(r.caveats) + '</p></article>';
  }

  return { DICT, JARGON, STAGES, DEFAULTS, SCHEMA, PRICE, facts, draft, verify, request, renderHtml, grade, syllables, fmtDate, fmtTime, fmtMoney, validISO, termsUsed, systemPrompt };
});
