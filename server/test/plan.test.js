import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildPlan, RULES } from '../src/plan.js';

// The page keeps its own copy of the rules so it still works offline. This test runs that copy
// and the server for every passport, airport, purpose and answer, and requires identical output.
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const grab = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert.ok(a >= 0 && b > a, `missing ${from}`); return html.slice(a, b); };
const code = [
  html.split('\n').filter(l => /^const (DAY|sod|addDays|isoDate)=/.test(l)).join('\n'),
  html.split('\n').filter(l => /^const (COUNTRIES|PORTS|PURP)=/.test(l)).join('\n'),
  grab('function routeFor', 'function renderTicket'),
  'this.routeFor=routeFor;this.docsFor=docsFor;this.datesFor=datesFor;this.isoDate=isoDate;',
].join('\n');
const page = {}; vm.runInNewContext(code, page);
const TODAY = '2026-10-30';

test('server plan equals the page plan for every input', () => {
  let n = 0;
  for (const c of RULES.countries) for (const p of RULES.ports) for (const purpose of Object.keys(RULES.purposes))
    for (const prior of ['yes', 'no']) for (const pak of ['yes', 'no']) {
      const input = { nat: c.code, port: p.code, purpose, arr: '2026-11-20', prior, pak, mil: 'no' };
      const s = buildPlan(input, TODAY);
      const st = { ...input, arr: new Date('2026-11-20T00:00:00') };
      const r = page.routeFor(st), docs = JSON.parse(JSON.stringify(page.docsFor(r, st))), dates = JSON.parse(JSON.stringify(page.datesFor(r, st).map(d => [d[0], page.isoDate(d[1]), d[2]]))); // the page runs in another realm: compare plain data
      assert.deepEqual([s.type, s.kind, s.title, s.reason], [r.type, r.kind, r.title, r.reason], JSON.stringify(input));
      assert.deepEqual(s.docs.map(d => [d.name, d.detail]), docs, JSON.stringify(input));
      assert.deepEqual(s.dates.map(d => [d.label, d.date, d.hot]), dates, JSON.stringify(input));
      n++;
    }
  assert.equal(n, RULES.countries.length * RULES.ports.length * 3 * 4);
});

test('warns when the apply-by date has passed', () => {
  const p = buildPlan({ nat: 'US', port: 'DEL', purpose: 'tourism', arr: '2026-11-02', prior: 'no', pak: 'no', mil: 'no' }, TODAY);
  assert.equal(p.type, 'evisa');
  assert.deepEqual(p.warnings.map(w => w.code), ['tight']);
  assert.equal(p.daysToArrival, 3);
});

test('visa on arrival is refused at an airport outside the six', () => {
  const p = buildPlan({ nat: 'JP', port: 'COK', purpose: 'tourism', arr: '2026-12-01', prior: 'no', pak: 'no', mil: 'no' }, TODAY);
  assert.equal(p.type, 'evisa');
  assert.match(p.reason, /not one of them/);
});

test('Pakistani origin answer sends the traveller to a mission, even with a visa-on-arrival passport', () => {
  const p = buildPlan({ nat: 'JP', port: 'DEL', purpose: 'tourism', arr: '2026-12-01', prior: 'no', pak: 'yes', mil: 'no' }, TODAY);
  assert.equal(p.type, 'mission');
});
