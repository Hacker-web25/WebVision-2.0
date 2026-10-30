import { buildPlan, addDaysISO, todayISO } from './plan.js';
import { sha256, token } from './secure.js';

const HOUR = 36e5, DAY = 864e5;
const prettyDate = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const NINE_LOCAL = (iso, tz) => Date.parse(iso + 'T09:00:00Z') - tz * 60000;

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function makeReminders({ db, vault, mailer, now }) {
  const q = {
    trip: db.prepare('SELECT * FROM trips WHERE id = ? AND expires_at > ?'),
    recent: db.prepare('SELECT COUNT(*) AS n FROM batches WHERE email_hash = ? AND created_at > ?'),
    addBatch: db.prepare('INSERT INTO batches (id, email_enc, email_hash, confirm_hash, unsub_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    addReminder: db.prepare('INSERT INTO reminders (batch_id, kind, due_at, payload) VALUES (?, ?, ?, ?)'),
    byConfirm: db.prepare('SELECT id, confirmed_at FROM batches WHERE confirm_hash = ?'),
    confirm: db.prepare('UPDATE batches SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL'),
    byUnsub: db.prepare('SELECT id FROM batches WHERE unsub_hash = ?'),
    del: db.prepare('DELETE FROM batches WHERE id = ?'),
    due: db.prepare(`SELECT r.id, r.kind, r.payload, r.attempts, b.id AS batch_id, b.email_enc
                     FROM reminders r JOIN batches b ON b.id = r.batch_id
                     WHERE b.confirmed_at IS NOT NULL AND b.email_enc IS NOT NULL AND r.sent_at IS NULL AND r.due_at <= ? AND r.attempts < 5
                     ORDER BY r.due_at LIMIT 50`),
    sent: db.prepare('UPDATE reminders SET sent_at = ? WHERE id = ?'),
    failed: db.prepare('UPDATE reminders SET attempts = attempts + 1 WHERE id = ?'),
    scrub: db.prepare(`UPDATE batches SET email_enc = NULL WHERE email_enc IS NOT NULL AND confirmed_at IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.batch_id = batches.id AND r.sent_at IS NULL AND r.attempts < 5)`),
    purge: db.prepare('DELETE FROM batches WHERE confirmed_at IS NULL AND created_at < ?'),
  };

  function plan(kind, input) {
    const out = [], skipped = [], t = now();
    if (kind === 'payment') {
      const due = Date.parse(input.paidAt) + 4 * HOUR;
      (due > t ? out : skipped).push(due > t
        ? { kind: 'payment', due, label: 'Check your payment status', payload: { paidAt: input.paidAt } }
        : { kind: 'payment', reason: 'The four hours are already over. Use Verify Payment on the official site now.' });
      return { out, skipped };
    }
    const { trip, tz } = input;
    const p = JSON.parse(trip.plan_json), r = buildPlan(p, todayISO(t, tz));
    const add = (kindName, label, iso, offsetDays) => {
      const due = NINE_LOCAL(addDaysISO(iso, offsetDays), tz);
      if (due > t) out.push({ kind: kindName, due, label, payload: { label, date: iso, port: r.port.name, visa: r.kind } });
      else skipped.push({ kind: kindName, reason: 'That date has already passed.' });
    };
    const applyBy = r.dates.find(d => d.label === 'Apply by'), card = r.dates.find(d => d.label === 'Arrival Card');
    if (applyBy) add('apply-by', 'Apply for your e-Visa', applyBy.date, -1);
    if (card) add('arrival-card', 'The e-Arrival Card opens today', card.date, 0);
    add('landing', 'You land tomorrow', p.arr, -1);
    return { out, skipped };
  }

  async function schedule({ body, baseUrl }) {
    const t = now(), email = body.email;
    let trip = null;
    if (body.kind === 'dates') {
      trip = q.trip.get(body.tripId, t);
      if (!trip) throw new HttpError(404, 'trip_not_found', 'That trip does not exist or has expired.');
    }
    const { out, skipped } = plan(body.kind, { trip, tz: body.tzOffsetMinutes, paidAt: body.paidAt });
    if (!out.length) throw new HttpError(422, 'nothing_to_schedule', 'Every reminder for this request is already in the past.');
    const eh = vault.emailHash(email);
    if (q.recent.get(eh, t - DAY).n >= 3) throw new HttpError(429, 'too_many', 'Too many reminder requests for this address today.');

    const id = token(12), confirm = token(), unsub = token();
    db.exec('BEGIN');
    try {
      q.addBatch.run(id, vault.encrypt(email), eh, sha256(confirm), sha256(unsub), t);
      for (const r of out) q.addReminder.run(id, r.kind, r.due, JSON.stringify({ label: r.label, ...r.payload }));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    await mailer.send({
      to: email, subject: 'Confirm your Pravesh reminders',
      text: [
        'Someone asked for Pravesh to email you about an India entry plan.',
        '',
        'Reminders waiting for your confirmation:',
        ...out.map(r => `- ${r.label}`),
        '',
        `Confirm: ${baseUrl}/api/reminders/confirm?token=${confirm}`,
        `Not you? Do nothing and they will be deleted, or cancel now: ${baseUrl}/api/reminders/unsubscribe?token=${unsub}`,
        '',
        'Pravesh is an unofficial companion. It is not the Government of India.',
      ].join('\n'),
    });
    return {
      status: 'confirmation_sent', delivery: mailer.mode,
      scheduled: out.map(r => ({ kind: r.kind, label: r.label, dueAt: new Date(r.due).toISOString() })),
      skipped,
    };
  }

  function confirm(tok) {
    const row = q.byConfirm.get(sha256(tok));
    if (!row) return false;
    q.confirm.run(now(), row.id);
    return true;
  }

  function unsubscribe(tok) {
    const row = q.byUnsub.get(sha256(tok));
    if (!row) return false;
    q.del.run(row.id);
    return true;
  }

  function compose(kind, p) {
    if (kind === 'payment') return {
      subject: 'Four hours have passed. Check your e-Visa payment',
      text: ['It has been four hours since your payment at ' + p.paidAt + '.', '', 'Do not pay again yet. Use Verify Payment on the official e-Visa site.',
        'If it still shows unpaid, send the evidence email to indian-evisa@gov.in with your bank reference.', '', 'https://indianvisaonline.gov.in/evisa/tvoa.html'].join('\n') };
    const when = prettyDate(p.date);
    const lines = {
      'apply-by': [`Apply for your ${p.visa} by ${when}.`, 'Fix your photo and passport scan first, so the upload is accepted the first time.'],
      'arrival-card': [`The e-Arrival Card for ${p.port} can be filed from today. Landing is within 72 hours.`, 'File it on the official site and keep the confirmation with your passport.'],
      landing: [`You land in ${p.port} tomorrow.`, 'Carry your passport and a printed approval or arrival-card confirmation.'],
    }[kind];
    return { subject: `${p.label}${kind === 'apply-by' ? ' by ' + when : ''}`, text: [...lines, '', 'https://indianvisaonline.gov.in'].join('\n') };
  }

  async function runDue() {
    let sent = 0;
    for (const r of q.due.all(now())) {
      try {
        const { subject, text } = compose(r.kind, JSON.parse(r.payload));
        await mailer.send({ to: vault.decrypt(r.email_enc), subject, text: text + '\n\nSent by Pravesh, an unofficial companion. To stop reminders, use the cancel link in your confirmation email.' });
        q.sent.run(now(), r.id); sent++;
      } catch { q.failed.run(r.id); }
    }
    q.scrub.run();
    return sent;
  }

  const purge = () => q.purge.run(now() - DAY);
  return { schedule, confirm, unsubscribe, runDue, purge };
}
