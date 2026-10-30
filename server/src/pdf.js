import PDFDocument from 'pdfkit';

/** A plain, one-page evidence letter. Built from the request and thrown away: nothing is stored. */
export function evidenceLetter(d) {
  const when = new Date(d.paidAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const doc = new PDFDocument({ size: 'A4', margin: 64, info: { Title: 'Payment evidence', Creator: 'Pravesh (unofficial)' } });
  doc.font('Helvetica-Bold').fontSize(14).text(`Fee debited, status not updated. Application ${d.app}`);
  doc.moveDown(1.2).font('Helvetica').fontSize(11.5);
  const p = t => doc.text(t, { lineGap: 3 }).moveDown(.9);
  p('Dear e-Visa Helpdesk,');
  p(`My e-Visa fee was debited on ${when} (shown to me as ${d.tz}), but my application still shows as unpaid after waiting 4 hours.`);
  doc.text(`Application ID: ${d.app}`, { lineGap: 3 });
  doc.text(`Amount debited: ${d.amount}`, { lineGap: 3 });
  doc.text(`Payment gateway: ${d.gateway}`, { lineGap: 3 });
  doc.text(`Bank reference: ${d.ref}`, { lineGap: 3 }).moveDown(.9);
  p('I have not paid again, to avoid blocking the application. Please confirm the payment status or tell me the next step.');
  p('Regards,\n' + d.name);
  doc.moveDown(2).font('Helvetica').fontSize(9).fillColor('#666').text('Prepared with Pravesh, an unofficial companion. Send to indian-evisa@gov.in and copy your payment gateway helpdesk. Attach a screenshot of the debit from your bank app.');
  doc.end();
  return doc;
}
