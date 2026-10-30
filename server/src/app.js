import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { RULES, buildPlan, todayISO } from './plan.js';
import { planInput, tripBody, reminderBody, evidenceBody } from './schemas.js';
import { HttpError, makeReminders } from './reminders.js';
import { evidenceLetter } from './pdf.js';
import { safeEqualHex, sha256, token } from './secure.js';

const TRIP_TTL = 180 * 864e5;
const INDEX = new URL('../../index.html', import.meta.url);
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 24px;color:#1f2b4d}a{color:#1f2b4d}</style><h1>${title}</h1>${body}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseWithFields(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const err = new HttpError(400, 'invalid_request', 'The request did not pass validation.');
  err.fields = Object.fromEntries(r.error.issues.map(i => [i.path.join('.') || '_', i.message]));
  throw err;
}

export function createApp({ db, vault, mailer, now = Date.now, env = process.env, limits = true }) {
  const app = express();
  const reminders = makeReminders({ db, vault, mailer, now });
  const dev = env.NODE_ENV !== 'production' || env.ALLOW_DEV_OUTBOX === '1';
  const baseUrl = req => env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', Number(env.TRUST_PROXY) || env.TRUST_PROXY);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  // The API holds no cookies and trusts no origin: access is by unguessable link or token, so any page may call it.
  app.use('/api', (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-edit-token', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  if (env.LOG_REQUESTS === '1') app.use((req, res, next) => { const t = Date.now(); res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`)); next(); });
  const limiter = (windowMs, limit) => limits ? rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many requests. Try again later.' } } }) : (q, r, n) => n();
  app.use('/api', limiter(60_000, 120));
  app.use(express.json({ limit: '20kb' }));

  /* ---- Front end: one file, served explicitly so nothing else in the repo is ever exposed ---- */
  app.get('/', (req, res) => { res.set('Content-Security-Policy', CSP); res.sendFile(INDEX.pathname); });

  /* ---- Health and rules ---- */
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, rulesVersion: RULES.version, mailer: mailer.mode, uptimeSec: Math.round(process.uptime()) });
  });

  app.get('/api/rules', (req, res) => {
    const { version, checkedOn, scope, constants, countries, ports, purposes, gateways, sources, helpdesks } = RULES;
    res.json({ version, checkedOn, scope, constants, countries, ports, purposes: Object.fromEntries(Object.entries(purposes).map(([k, v]) => [k, v.visa])), gateways, sources, helpdesks });
  });

  /* ---- Entry plan ---- */
  app.post('/api/plan', (req, res) => {
    const input = parseWithFields(planInput, req.body);
    res.json(buildPlan(input, todayISO(now(), input.tzOffsetMinutes ?? 330)));
  });

  /* ---- Trips: saved by link, edited by token, gone after 180 days of silence ---- */
  const T = {
    get: db.prepare('SELECT * FROM trips WHERE id = ? AND expires_at > ?'),
    add: db.prepare('INSERT INTO trips (id, edit_hash, plan_json, people_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    put: db.prepare('UPDATE trips SET plan_json = ?, people_json = ?, updated_at = ?, expires_at = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM trips WHERE id = ?'),
  };
  const ID = /^[A-Za-z0-9_-]{22}$/;
  const view = (row, tz = 330) => {
    const plan = JSON.parse(row.plan_json);
    return { id: row.id, plan, travellers: JSON.parse(row.people_json), result: buildPlan(plan, todayISO(now(), tz)), updatedAt: new Date(row.updated_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
  };
  const load = (req, needToken) => {
    if (!ID.test(req.params.id)) throw new HttpError(404, 'trip_not_found', 'That trip does not exist or has expired.');
    const row = T.get.get(req.params.id, now());
    if (!row) throw new HttpError(404, 'trip_not_found', 'That trip does not exist or has expired.');
    if (needToken) {
      const t = req.get('x-edit-token');
      if (!t || !safeEqualHex(sha256(t), row.edit_hash)) throw new HttpError(403, 'bad_edit_token', 'This trip can only be changed with its edit token.');
    }
    return row;
  };

  app.post('/api/trips', limiter(3_600_000, 40), (req, res) => {
    const b = parseWithFields(tripBody, req.body), id = token(16), edit = token(24), t = now();
    T.add.run(id, sha256(edit), JSON.stringify(b.plan), JSON.stringify(b.travellers), t, t, t + TRIP_TTL);
    res.status(201).json({ id, editToken: edit, link: `${baseUrl(req)}/?trip=${id}`, expiresAt: new Date(t + TRIP_TTL).toISOString() });
  });
  app.get('/api/trips/:id', (req, res) => res.json(view(load(req, false), Number(req.query.tz) || 330)));
  app.put('/api/trips/:id', (req, res) => {
    const row = load(req, true), b = parseWithFields(tripBody, req.body), t = now();
    T.put.run(JSON.stringify(b.plan), JSON.stringify(b.travellers), t, t + TRIP_TTL, row.id);
    res.json(view(T.get.get(row.id, t)));
  });
  app.delete('/api/trips/:id', (req, res) => { T.del.run(load(req, true).id); res.sendStatus(204); });

  /* ---- Reminders: double opt-in, email encrypted at rest, scrubbed once everything is sent ---- */
  app.post('/api/reminders', limiter(3_600_000, 10), async (req, res) => {
    res.status(202).json(await reminders.schedule({ body: parseWithFields(reminderBody, req.body), baseUrl: baseUrl(req) }));
  });
  app.get('/api/reminders/confirm', (req, res) => {
    const ok = reminders.confirm(String(req.query.token || ''));
    res.status(ok ? 200 : 404).type('html').send(ok ? page('Reminders confirmed', '<p>You will get them on the dates in your plan. Every email has a way to stop them.</p>') : page('Link not recognised', '<p>It may already have been used, or it has expired.</p>'));
  });
  const unsub = (req, res) => {
    const ok = reminders.unsubscribe(String(req.query.token || ''));
    res.status(ok ? 200 : 404).type('html').send(ok ? page('Reminders cancelled', '<p>Nothing more will be sent, and the address has been removed.</p>') : page('Link not recognised', '<p>It may already have been used.</p>'));
  };
  app.get('/api/reminders/unsubscribe', unsub);
  app.post('/api/reminders/unsubscribe', unsub);

  /* ---- Payment evidence letter: rendered and returned, never stored ---- */
  app.post('/api/evidence/letter.pdf', limiter(3_600_000, 40), (req, res) => {
    const d = parseWithFields(evidenceBody, req.body);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="payment-evidence.pdf"' });
    evidenceLetter(d).pipe(res);
  });

  /* ---- Demo inbox: only outside production, shows mail that the outbox mailer kept ---- */
  if (dev) {
    const rows = () => db.prepare('SELECT id, to_addr, subject, body, created_at FROM outbox ORDER BY id DESC LIMIT 20').all();
    app.get('/api/dev/outbox', (req, res) => res.json(rows()));
    app.get('/dev/outbox', (req, res) => {
      const link = s => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
      res.type('html').send(page('Demo inbox', rows().map(m => `<section style="margin:0 0 32px"><b>${esc(m.subject)}</b><br><small>to ${esc(m.to_addr)}</small><pre style="white-space:pre-wrap;font:15px/1.5 inherit">${link(m.body)}</pre></section>`).join('') || '<p>No mail yet.</p>'));
    });
  }

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }));
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'The body is not valid JSON.' } });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'The body is too large.' } });
    console.error('unhandled', err.message);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
  });

  return { app, reminders, purgeTrips: () => db.prepare('DELETE FROM trips WHERE expires_at <= ?').run(now()) };
}
