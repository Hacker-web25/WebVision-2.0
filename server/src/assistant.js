import { RULES } from './plan.js';

/* The assistant answers from the rules below and the trip summary the page sends. It never sees
   passport images, names, numbers or birth dates: the page sends only check results. */

const FACTS = `
Sourced facts (cite the source name when you use one):
- e-Tourist 30 days: valid 30 days from first arrival, multiple entry, non-extendable, non-convertible. [Official e-Visa page]
- e-Tourist 1 year / 5 years: valid from the grant date, multiple entry. Continuous stay per visit up to 90 days, or 180 days for US, UK, Canada and Japan nationals. No more than 180 days in a calendar year. [Official e-Visa page]
- e-Business: one year from grant, multiple entry, continuous stay up to 180 days per visit. [Official e-Visa page]
- e-Medical: the official page gives two different figures (one year from arrival in its table, 60 days in its FAQ). Say this, do not pick one. [Official e-Visa page]
- Apply at least ${RULES.constants.applyBeforeDays} days before arrival. The e-Visa fee is non-refundable. A 3% bank charge is added. [Official e-Visa page]
- Passport: at least six months validity when you apply. [Official e-Visa page]
- The e-Visa is not valid for Protected/Restricted Areas or Cantonment areas. [Official e-Visa page]
- Visa on arrival: up to ${RULES.constants.voaStayDays} days, ${RULES.constants.voaEntries} entries, only at the ${RULES.constants.voaAirportCount} designated airports. [Rules on this site]
- e-Arrival Card: file within ${RULES.constants.arrivalCardHours} hours before landing. [Rules on this site]
- Payment: status can take up to ${RULES.constants.paymentRecheckHours} hours to update after a debit; more than ${RULES.constants.maxFailedPayments} failed attempts blocks the application. [Official e-Visa home page]
- Customs, Baggage Rules 2026 (arrival by air): free allowance Rs 25,000 for a foreign tourist, Rs 75,000 for residents, tourists of Indian origin and foreigners on non-tourist visas. Not shared between travellers. Outside the allowance (Annexure-I): firearms, cartridges over 50, cigarettes over 100 / cigars over 25 / tobacco over 125 g, alcohol or wine over 2 litres, gold or silver other than ornaments, television. One new laptop free for anyone 18+. Used personal effects free. Jewellery after more than a year abroad (residents / Indian origin): 20 g, or 40 g for a female passenger. [Baggage Rules, 2026]
- Duty rate on excess: NOT confirmed for 2026. 38.5% was the 2016 figure.
- Currency: declare when foreign banknotes exceed USD 5,000 or banknotes plus travellers' cheques exceed USD 10,000. Not read from the regulation itself: tell the user to confirm. Rules on carrying Indian rupees: not confirmed.
- Contacts: e-Visa helpdesk +91 82 7808 7808, indian-evisa@gov.in [Official e-Visa home page]. Emergency 112, tourist helpline 1363 [Incredible India emergency page].
`;

const SYSTEM = `You are the Pravesh assistant, inside an unofficial pre-flight companion for India's e-Visa.
Rules you must follow:
- Pravesh never submits applications, never takes payments and is not the Government of India. You cannot submit or pay for the user. The user applies on https://indianvisaonline.gov.in. Say so plainly if asked.
- Answer only from the sourced facts and the trip summary below. If they do not cover the question, say you do not know and point to the official site. Never invent rules, fees or numbers. Never promise approval.
- Keep replies short: at most 6 sentences or a short list. Plain English.
- You can change the user's dashboard with actions. Only use them when the user asks or clearly implies it.
Reply with ONE JSON object and nothing else:
{"reply": "text for the user", "actions": [ ... ]}
Allowed actions:
{"type":"addItem","kind":<one of elec,laptop,gift,jewel,alc,cig,cigar,tob,gold,tv,used,arms,drone,satph,meds>,"qty":number,"value":number in rupees}
{"type":"setStatus","value":<none|sub|paid|ok|no>}
{"type":"setNights","value":number}
{"type":"setVisa","value":<voa|t30|t1y|t5y|b1|med>}
{"type":"setPlan","nat":<country code>,"port":<airport code>,"purpose":<tourism|business|medical>,"arr":"YYYY-MM-DD"} (any subset)
{"type":"goTab","value":<over|visa|cust|cost|help|india>}
Country codes: ${RULES.countries.map(c => `${c.code}=${c.name}`).join(', ')}.
Airport codes: ${RULES.ports.map(p => `${p.code}=${p.name}`).join(', ')}.
${FACTS}`;

const KINDS = ['elec', 'laptop', 'gift', 'jewel', 'alc', 'cig', 'cigar', 'tob', 'gold', 'tv', 'used', 'arms', 'drone', 'satph', 'meds'];
const num = (x, max) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : null);

/** Keep only well-formed actions, so the model can never drive the page outside this list. */
export function cleanActions(list) {
  if (!Array.isArray(list)) return [];
  const codes = { nat: RULES.countries.map(c => c.code), port: RULES.ports.map(p => p.code), purpose: Object.keys(RULES.purposes) };
  const out = [];
  for (const a of list.slice(0, 12)) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'addItem' && KINDS.includes(a.kind)) out.push({ type: 'addItem', kind: a.kind, qty: num(a.qty, 1e4) ?? 0, value: num(a.value, 1e8) ?? 0 });
    else if (a.type === 'setStatus' && ['none', 'sub', 'paid', 'ok', 'no'].includes(a.value)) out.push(a);
    else if (a.type === 'setNights' && num(a.value, 365)) out.push({ type: 'setNights', value: Math.round(a.value) });
    else if (a.type === 'setVisa' && ['voa', 't30', 't1y', 't5y', 'b1', 'med'].includes(a.value)) out.push(a);
    else if (a.type === 'goTab' && ['over', 'visa', 'cust', 'cost', 'help', 'india'].includes(a.value)) out.push(a);
    else if (a.type === 'setPlan') {
      const p = { type: 'setPlan' };
      for (const k of ['nat', 'port', 'purpose']) if (codes[k].includes(a[k])) p[k] = a[k];
      if (typeof a.arr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.arr)) p.arr = a.arr;
      if (Object.keys(p).length > 1) out.push(p);
    }
  }
  return out;
}

/** Pull the JSON object out of a model reply, tolerating code fences or stray text. */
export function parseReply(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { const o = JSON.parse(s.slice(i, j + 1)); if (typeof o.reply === 'string') return { reply: o.reply.slice(0, 3000), actions: cleanActions(o.actions) }; } catch { /* fall through */ }
  }
  return { reply: s.replace(/```[a-z]*|```/g, '').trim().slice(0, 3000) || 'Sorry, I could not answer that.', actions: [] };
}

export function buildMessages({ messages, context }) {
  return [{ role: 'system', content: `${SYSTEM}\nTrip summary from the page (JSON):\n${JSON.stringify(context)}` }, ...messages];
}

/** OpenAI-compatible chat call: NVIDIA build first, Gemini as a fallback. Returns null when no key is set. */
export function modelFromEnv(env) {
  const providers = [];
  if (env.NVIDIA_API_KEY) providers.push({ name: 'NVIDIA', url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: env.NVIDIA_API_KEY, model: env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct' });
  if (env.GEMINI_API_KEY) providers.push({ name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || 'gemini-2.0-flash' });
  if (!providers.length) return null;
  return async messages => {
    let last;
    for (const p of providers) {
      try {
        const r = await fetch(p.url, {
          method: 'POST', signal: AbortSignal.timeout(60000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
          body: JSON.stringify({ model: p.model, messages, temperature: 0.2, max_tokens: 2500 }),
        });
        if (!r.ok) throw new Error(`${p.name} answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const j = await r.json(), c = j.choices?.[0];
        // Reasoning models can spend the whole budget thinking and return no answer: treat that as a failure.
        if (!c?.message?.content?.trim()) throw new Error(`${p.name} returned no answer (finish_reason: ${c?.finish_reason})`);
        return { text: c.message.content, provider: p.name };
      } catch (e) { last = e; }
    }
    throw last;
  };
}
