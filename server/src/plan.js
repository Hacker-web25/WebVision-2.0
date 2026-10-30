// The entry-plan rules, as pure functions. Everything here is deterministic given the input,
// the rules file and "today", so it can be tested against the front end's own copy.
import { readFileSync } from 'node:fs';

export const RULES = JSON.parse(readFileSync(new URL('./rules/india-evisa.json', import.meta.url), 'utf8'));

const DAY = 864e5;
const parse = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fmt = ms => new Date(ms).toISOString().slice(0, 10);
export const addDaysISO = (iso, n) => fmt(parse(iso) + n * DAY);
export const daysBetween = (aIso, bIso) => Math.round((parse(bIso) - parse(aIso)) / DAY);

/** "Today" as a calendar date for someone whose clock is tzOffsetMinutes ahead of UTC. */
export function todayISO(nowMs, tzOffsetMinutes = 330) {
  return fmt(nowMs + tzOffsetMinutes * 60000);
}

export function buildPlan(input, today, rules = RULES) {
  const c = rules.countries.find(x => x.code === input.nat);
  const port = rules.ports.find(p => p.code === input.port);
  const purpose = rules.purposes[input.purpose];
  const k = c.regime, dem = c.demonym, K = rules.constants;

  let type, kind, title, reason;
  const voa = k === 'voa' || (k === 'voa-prior' && input.prior === 'yes');
  if (k === 'mission') {
    type = 'mission'; kind = 'Regular visa'; title = 'Apply through an Indian mission.';
    reason = 'Pakistani passport holders apply for a regular visa through an Indian mission. The e-Visa is not available to them.';
  } else if (input.pak === 'yes') {
    type = 'mission'; kind = 'Regular visa'; title = 'Apply through an Indian mission.';
    reason = 'The e-Visa instructions send applicants of Pakistani origin to an Indian mission for a regular visa. If your only link is birth before 1947 in undivided India, ask the mission how to answer.';
  } else if (k === 'check') {
    type = 'check'; kind = 'Check first'; title = 'Confirm your country is eligible.';
    reason = 'This demonstration covers 19 countries. Check the official list of e-Visa countries before you start.';
  } else if (voa && port.voa) {
    type = 'voa'; kind = 'Visa on arrival'; title = 'No online application needed.';
    reason = `${dem} nationals can get a visa on arrival at ${port.name}, one of six designated airports. It allows up to ${K.voaStayDays} days and two entries.`;
  } else {
    type = 'evisa'; kind = 'e-Visa';
    title = `Apply online for an ${purpose.visa.replace('e-', 'e‑')}.`;
    reason = `${dem} nationals apply online and receive approval by email before flying.`;
    if (voa && !port.voa) reason = `Visa on arrival works at six airports only, and ${port.name} is not one of them. Apply for an e-Visa instead.`;
    else if (k === 'voa-prior') reason = 'Emirati nationals get a visa on arrival only after holding an Indian e-Visa or paper visa before. For a first visit, apply online.';
  }

  let docs;
  if (type === 'voa') docs = [['Passport', 'Valid, with your current details'], ['e-Arrival Card', `Filed within ${K.arrivalCardHours} hours of landing`]];
  else if (type === 'mission') docs = [['Regular visa form', 'Through the mission or its visa centre']];
  else if (type === 'check') docs = [['Official country list', 'On indianvisaonline.gov.in']];
  else {
    docs = [['Face photo', `JPEG, ${K.fileKb.min}–${K.fileKb.max} KB, square`], ['Passport page', `PDF, ${K.fileKb.min}–${K.fileKb.max} KB`]];
    if (purpose.extraDoc) docs.push([purpose.extraDoc.name, purpose.extraDoc.detail]);
    docs.push(['e-Arrival Card', `Filed within ${K.arrivalCardHours} hours of landing`]);
  }

  const dates = [];
  if (type === 'evisa') dates.push({ label: 'Apply by', date: addDaysISO(input.arr, -K.applyBeforeDays), hot: true });
  if (type === 'voa' || type === 'evisa') dates.push({ label: 'Arrival Card', date: addDaysISO(input.arr, -K.arrivalCardOpensDaysBefore), hot: false });
  dates.push({ label: 'Land', date: input.arr, hot: false });

  const notes = [];
  if (input.mil === 'yes') notes.push('The form asks for your organisation, rank and place of posting. Past service does not rule you out. Keep the details ready.');
  else if (type === 'voa') notes.push('Flying into another airport later? An e-Visa works at all of them.');

  const warnings = [];
  const applyBy = dates.find(d => d.label === 'Apply by');
  if (applyBy && daysBetween(today, applyBy.date) < 0) warnings.push({ code: 'tight', text: 'Less than 4 days to go. Apply today and expect it to be tight.' });
  if (daysBetween(today, input.arr) < 0) warnings.push({ code: 'past', text: 'This arrival date has already passed.' });

  return {
    rulesVersion: rules.version, checkedOn: rules.checkedOn,
    type, kind, title, reason,
    country: { code: c.code, name: c.name, demonym: c.demonym },
    port: { code: port.code, name: port.name, voa: port.voa },
    docs: docs.map(([name, detail]) => ({ name, detail })),
    dates, notes, warnings,
    daysToArrival: daysBetween(today, input.arr),
    source: type === 'voa' ? rules.sources.voa : rules.sources.evisa,
  };
}
