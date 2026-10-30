/** Two ways to deliver: "outbox" keeps mail in the database for the demo inbox, "smtp" sends it. */
export async function makeMailer({ mode, db, now, env = process.env }) {
  if (mode === 'smtp') {
    const { default: nodemailer } = await import('nodemailer');
    const t = nodemailer.createTransport(env.SMTP_URL);
    const from = env.MAIL_FROM || 'Pravesh <no-reply@localhost>';
    return { mode, send: ({ to, subject, text }) => t.sendMail({ from, to, subject, text }) };
  }
  const ins = db.prepare('INSERT INTO outbox (to_addr, subject, body, created_at) VALUES (?, ?, ?, ?)');
  return { mode: 'outbox', send: async ({ to, subject, text }) => { ins.run(to, subject, text, now()); } };
}
