import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { makeMailer } from '../src/mailer.js';
import { makeVault } from '../src/secure.js';
import { randomBytes } from 'node:crypto';

/** A real server on a random port, an in-memory database and a clock the test controls. */
export async function boot({ start = Date.parse('2026-10-30T06:00:00Z'), limits = false } = {}) {
  const clock = { t: start };
  const now = () => clock.t;
  const db = openDb(':memory:');
  const vault = makeVault(randomBytes(32));
  const mailer = await makeMailer({ mode: 'outbox', db, now });
  const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://pravesh.test' };
  const { app, reminders, purgeTrips } = createApp({ db, vault, mailer, now, env, limits });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : type.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, headers: res.headers, data };
  };
  return { call, db, clock, reminders, purgeTrips, base, close: () => new Promise(r => { server.close(r); db.close(); }) };
}
export const outbox = db => db.prepare('SELECT * FROM outbox ORDER BY id').all();
