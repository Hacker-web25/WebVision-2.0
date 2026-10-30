import { z } from 'zod';
import { RULES } from './plan.js';

const codes = list => z.enum(list.map(x => x.code));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(s => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Not a real date');
const yn = z.enum(['yes', 'no']);
const tz = z.number().int().min(-720).max(840);

export const planInput = z.strictObject({
  nat: codes(RULES.countries),
  port: codes(RULES.ports),
  purpose: z.enum(Object.keys(RULES.purposes)),
  arr: isoDate,
  prior: yn.default('no'),
  pak: yn.default('no'),
  mil: yn.default('no'),
  tzOffsetMinutes: tz.optional(),
});

const STEP = z.enum(['done', 'warn', 'todo', 'wait']);
// First names and progress only. No passport numbers, dates of birth or addresses are accepted.
export const traveller = z.strictObject({
  n: z.string().trim().min(1).max(40),
  m: z.string().trim().max(60),
  s: z.array(STEP).length(5),
});

const planCore = planInput.omit({ tzOffsetMinutes: true });
export const tripBody = z.strictObject({ plan: planCore, travellers: z.array(traveller).max(10).default([]) });

export const reminderBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dates'), email: z.string().trim().toLowerCase().email().max(120), tripId: z.string().regex(/^[A-Za-z0-9_-]{22}$/), tzOffsetMinutes: tz.default(330) }),
  z.strictObject({ kind: z.literal('payment'), email: z.string().trim().toLowerCase().email().max(120), paidAt: z.string().datetime({ offset: true }) }),
]);

const text = n => z.string().trim().min(1).max(n);
export const evidenceBody = z.strictObject({
  app: text(40), amount: text(40), ref: text(60), name: text(80),
  gateway: z.enum(RULES.gateways),
  paidAt: z.string().datetime({ offset: true }),
  tz: z.string().trim().max(64).default('local time'),
});
