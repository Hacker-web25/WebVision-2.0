import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, outbox } from './helpers.js';

let s;
before(async () => { s = await boot(); });
after(() => s.close());

const plan = { nat: 'US', port: 'DEL', purpose: 'tourism', arr: '2026-11-20', prior: 'no', pak: 'no', mil: 'no' };
const people = [{ n: 'Anna', m: 'Lead applicant', s: ['done', 'todo', 'todo', 'todo', 'wait'] }];
const T0 = Date.parse('2026-10-30T06:00:00Z');

test('health, rules and CORS', async () => {
  const h = await s.call('GET', '/api/health');
  assert.equal(h.status, 200); assert.equal(h.data.ok, true);
  assert.equal(h.headers.get('access-control-allow-origin'), '*');
  const r = await s.call('GET', '/api/rules');
  assert.equal(r.data.countries.length, 19); assert.equal(r.data.ports.length, 10);
  assert.equal((await s.call('OPTIONS', '/api/plan')).status, 204);
});

test('plan validates input and names the bad fields', async () => {
  const bad = await s.call('POST', '/api/plan', { ...plan, nat: 'ZZ', arr: '2026-13-45', extra: 1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'invalid_request');
  assert.ok(bad.data.error.fields.nat && bad.data.error.fields.arr);
  const ok = await s.call('POST', '/api/plan', plan);
  assert.equal(ok.status, 200); assert.equal(ok.data.type, 'evisa'); assert.equal(ok.data.dates[0].label, 'Apply by');
  const junk = await fetch(s.base + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(junk.status, 400);
});

test('trip lifecycle: create, read by link, edit only with the token, delete', async () => {
  const c = await s.call('POST', '/api/trips', { plan, travellers: people });
  assert.equal(c.status, 201);
  const { id, editToken } = c.data;
  assert.equal(id.length, 22);
  assert.ok(c.data.link.startsWith('http://pravesh.test/?trip='));

  const g = await s.call('GET', `/api/trips/${id}`);
  assert.equal(g.data.travellers[0].n, 'Anna'); assert.equal(g.data.result.type, 'evisa');
  assert.ok(!JSON.stringify(g.data).includes(editToken));

  assert.equal((await s.call('PUT', `/api/trips/${id}`, { plan, travellers: [] })).status, 403);
  assert.equal((await s.call('PUT', `/api/trips/${id}`, { plan, travellers: [] }, { 'x-edit-token': 'x'.repeat(32) })).status, 403);
  const up = await s.call('PUT', `/api/trips/${id}`, { plan: { ...plan, nat: 'JP' }, travellers: [...people, { n: 'Erik', m: '', s: ['done', 'done', 'warn', 'todo', 'wait'] }] }, { 'x-edit-token': editToken });
  assert.equal(up.status, 200); assert.equal(up.data.result.type, 'voa'); assert.equal(up.data.travellers.length, 2);

  assert.equal((await s.call('DELETE', `/api/trips/${id}`, undefined, { 'x-edit-token': editToken })).status, 204);
  assert.equal((await s.call('GET', `/api/trips/${id}`)).status, 404);
});

test('trips refuse personal fields and bad ids', async () => {
  const bad = await s.call('POST', '/api/trips', { plan, travellers: [{ n: 'Anna', m: '', s: ['done', 'todo', 'todo', 'todo', 'wait'], passportNumber: 'L898902C3' }] });
  assert.equal(bad.status, 400);
  assert.equal((await s.call('GET', '/api/trips/short')).status, 404);
  assert.equal((await s.call('GET', '/api/trips/' + 'A'.repeat(22))).status, 404);
});

test('trips expire after 180 days of silence', async () => {
  const c = await s.call('POST', '/api/trips', { plan, travellers: [] });
  s.clock.t = T0 + 179 * 864e5;
  assert.equal((await s.call('GET', `/api/trips/${c.data.id}`)).status, 200);
  s.clock.t = T0 + 181 * 864e5;
  assert.equal((await s.call('GET', `/api/trips/${c.data.id}`)).status, 404);
  s.purgeTrips();
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM trips WHERE id = ?').get(c.data.id).n, 0);
  s.clock.t = T0;
});

test('reminders: double opt-in, due-date delivery, address scrubbed afterwards', async () => {
  const c = await s.call('POST', '/api/trips', { plan, travellers: [] });
  const before = outbox(s.db).length;
  const r = await s.call('POST', '/api/reminders', { kind: 'dates', email: ' Dhruv@Example.com ', tripId: c.data.id, tzOffsetMinutes: 330 });
  assert.equal(r.status, 202); assert.equal(r.data.status, 'confirmation_sent');
  assert.deepEqual(r.data.scheduled.map(x => x.kind), ['apply-by', 'arrival-card', 'landing']);
  const mail = outbox(s.db); assert.equal(mail.length, before + 1);
  assert.equal(mail.at(-1).to_addr, 'dhruv@example.com');
  assert.match(mail.at(-1).subject, /Confirm/);

  // Not confirmed yet: nothing is sent even when due.
  s.clock.t = Date.parse('2026-11-30T00:00:00Z');
  assert.equal(await s.reminders.runDue(), 0);
  s.clock.t = T0;

  const link = mail.at(-1).body.match(/Confirm: (http\S+)/)[1].replace('http://pravesh.test', s.base);
  assert.equal((await fetch(link)).status, 200);

  // apply-by is 2026-11-16, reminded the day before at 09:00 IST = 03:30Z
  s.clock.t = Date.parse('2026-11-15T03:29:00Z'); assert.equal(await s.reminders.runDue(), 0);
  s.clock.t = Date.parse('2026-11-15T03:31:00Z'); assert.equal(await s.reminders.runDue(), 1);
  assert.equal(await s.reminders.runDue(), 0, 'a reminder is sent once');
  assert.match(outbox(s.db).at(-1).subject, /Apply for your e-Visa by Mon 16 Nov/);

  s.clock.t = Date.parse('2026-11-20T00:00:00Z'); assert.equal(await s.reminders.runDue(), 2);
  assert.ok(s.db.prepare('SELECT email_enc FROM batches').all().every(b => b.email_enc === null), 'address is deleted once nothing is left to send');
  s.clock.t = T0;
});

test('reminders: unsubscribe removes everything; a stranger cannot be spammed', async () => {
  const c = await s.call('POST', '/api/trips', { plan, travellers: [] });
  const r = await s.call('POST', '/api/reminders', { kind: 'dates', email: 'a@b.co', tripId: c.data.id });
  assert.equal(r.status, 202);
  const un = outbox(s.db).at(-1).body.match(/cancel now: (http\S+)/)[1].replace('http://pravesh.test', s.base);
  assert.equal((await fetch(un)).status, 200);
  assert.equal((await fetch(un)).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/reminders', { kind: 'dates', email: 'victim@x.io', tripId: c.data.id })).status, 202);
  assert.equal((await s.call('POST', '/api/reminders', { kind: 'dates', email: 'victim@x.io', tripId: c.data.id })).status, 429);
});

test('payment reminder fires four hours after payment; past payments are declined', async () => {
  const paid = new Date(s.clock.t - 3600e3).toISOString();
  const r = await s.call('POST', '/api/reminders', { kind: 'payment', email: 'pay@x.io', paidAt: paid });
  assert.equal(r.status, 202); assert.equal(r.data.scheduled[0].dueAt, new Date(Date.parse(paid) + 4 * 36e5).toISOString());
  const late = await s.call('POST', '/api/reminders', { kind: 'payment', email: 'late@x.io', paidAt: new Date(s.clock.t - 5 * 36e5).toISOString() });
  assert.equal(late.status, 422);
});

test('evidence letter is a PDF and is not stored', async () => {
  const tables = () => JSON.stringify(s.db.prepare("SELECT name, (SELECT COUNT(*) FROM sqlite_master) c FROM sqlite_master").all());
  const before = tables(), rows = s.db.prepare('SELECT (SELECT COUNT(*) FROM trips)+(SELECT COUNT(*) FROM batches)+(SELECT COUNT(*) FROM outbox) n').get().n;
  const res = await s.call('POST', '/api/evidence/letter.pdf', { app: 'ABC123', amount: 'USD 25.00', gateway: 'SBI', ref: 'REF-9', name: 'Anna Lindqvist', paidAt: '2026-10-30T04:40:00+05:30', tz: 'Asia/Calcutta' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.data.subarray(0, 5).toString(), '%PDF-');
  assert.equal(tables(), before);
  assert.equal(s.db.prepare('SELECT (SELECT COUNT(*) FROM trips)+(SELECT COUNT(*) FROM batches)+(SELECT COUNT(*) FROM outbox) n').get().n, rows);
  assert.equal((await s.call('POST', '/api/evidence/letter.pdf', { app: '', gateway: 'Nope' })).status, 400);
});

test('only the front-end file is served, and with a content security policy', async () => {
  const idx = await fetch(s.base + '/');
  assert.equal(idx.status, 200); assert.match(idx.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const p of ['/package.json', '/server/src/app.js', '/.env', '/server/data/secret.key']) assert.equal((await fetch(s.base + p)).status, 404, p);
  assert.equal((await s.call('GET', '/api/nope')).status, 404);
});
