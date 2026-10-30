import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { makeMailer } from './mailer.js';
import { loadKey, makeVault } from './secure.js';

const env = process.env;
const dataDir = env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const db = openDb(env.DB_PATH || join(dataDir, 'pravesh.db'));
const vault = makeVault(loadKey({ env, keyFile: join(dataDir, 'secret.key') }));
const mailer = await makeMailer({ mode: env.MAILER === 'smtp' ? 'smtp' : 'outbox', db, now: Date.now, env });
const { app, reminders, purgeTrips } = createApp({ db, vault, mailer, env });

if (env.NODE_ENV === 'production') {
  if (mailer.mode !== 'smtp') console.warn('WARNING: MAILER is not "smtp", so confirmation and reminder emails will not reach anyone.');
  if (!env.PUBLIC_URL) console.warn('WARNING: PUBLIC_URL is not set, so links in emails are built from the request Host header.');
}

const timers = [
  setInterval(() => reminders.runDue().catch(e => console.error('reminder run failed', e.message)), 30_000),
  setInterval(() => { purgeTrips(); reminders.purge(); }, 3_600_000),
];
timers.forEach(t => t.unref());

const port = Number(env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`Pravesh on http://localhost:${port}  (mail: ${mailer.mode}${mailer.mode === 'outbox' && env.NODE_ENV !== 'production' ? `, demo inbox at /dev/outbox` : ''})`);
});
const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
