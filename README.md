# WebVision 2.0

**Pravesh** is an unofficial pre-flight companion for India's e-Visa. It tells a traveller which way into India fits their passport, fixes the photo and passport scan to the published spec, and keeps proof of payment, so the official application goes through once.

It is not the Government of India, it takes no payments and it never submits an application. See "What Pravesh never does" on the page.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # 14 tests, no network needed
```

Needs Node 22.13 or newer. There is no database to install: data is one SQLite file in `server/data/`.

Opening `index.html` straight from disk also works. The page then calls the server on `localhost:3000` when it is running and falls back to its own built-in rules when it is not.

## How it fits together

```
index.html                 the whole front end, one file
server/src/app.js          routes, validation, rate limits, headers
server/src/plan.js         the entry-plan rules as pure functions
server/src/rules/*.json    the rules data: countries, airports, limits, sources, date checked
server/src/reminders.js    double opt-in reminders and the scheduler
server/src/pdf.js          the payment-evidence letter
server/src/db.js           SQLite schema (node:sqlite, no native build)
server/test/               unit and API tests
```

**Documents never leave the browser.** The photo and passport scan are cropped, whitened and compressed on the device. The server has no upload endpoint.

**The server is authoritative for the rules, the page still works without it.** The page renders its own answer instantly, asks `POST /api/plan`, and switches to the server's answer if the two ever differ. A test runs both implementations over every passport, airport, purpose and answer (2,280 combinations) and fails if they disagree.

## API

| Endpoint | What it does |
| --- | --- |
| `GET /api/health` | Liveness, rules version, mail mode |
| `GET /api/rules` | Countries, airports, limits, sources and the date the rules were checked |
| `POST /api/plan` | Entry plan for a passport, airport, purpose and date: route, documents, dates, warnings, source |
| `POST /api/trips` | Save a family trip. Returns an unguessable id and a one-time edit token |
| `GET /api/trips/:id` | Read a trip by its link, with the plan recomputed from current rules |
| `PUT /api/trips/:id` | Update it. Needs the `x-edit-token` header |
| `DELETE /api/trips/:id` | Delete it. Needs the token |
| `POST /api/reminders` | Ask for email reminders (`kind: "dates"` for a trip, `"payment"` for the 4-hour check). Sends a confirmation email first |
| `GET /api/reminders/confirm?token=` | Activate the reminders |
| `GET /api/reminders/unsubscribe?token=` | Cancel and delete the address |
| `POST /api/evidence/letter.pdf` | Render the payment-evidence letter as a PDF. Nothing is stored |

Errors are always `{ "error": { "code", "message", "fields?" } }`.

```bash
curl -s localhost:3000/api/plan -H 'content-type: application/json' \
  -d '{"nat":"JP","port":"BLR","purpose":"tourism","arr":"2026-11-20"}'
```

## Privacy and security choices

- **No accounts.** A trip is reached by a 128-bit random link and edited with a separate 192-bit token whose hash is all the server keeps. Trips are deleted after 180 days without an edit.
- **Minimal data.** A traveller is a first name, a short note and five progress marks. The schema is strict: passport numbers, birth dates and addresses are rejected.
- **Email is opt-in twice.** Nothing is scheduled until the address owner clicks the confirmation link, at most three requests per address per day, and every mail carries a cancel link. Addresses are encrypted at rest (AES-256-GCM) and deleted after the last reminder is sent.
- **Payment details are never stored.** The evidence letter is rendered from the request and returned.
- **Hardening.** Strict input validation (zod), 20 KB body limit, per-IP rate limits, `helmet` headers, a content security policy on the page, and only `index.html` is served: the rest of the repository is not reachable.

## Configuration

See `.env.example`. For a local demo nothing needs setting. Reminder emails then land in a demo inbox at `/dev/outbox` (switched off when `NODE_ENV=production`), so the whole flow can be shown without an email account.

## Free hosting

- **Anywhere with Docker:** `docker build -t webvision . && docker run -p 3000:3000 -v webvision-data:/data webvision`.
- **Render free plan:** `render.yaml` is included. The free plan has no persistent disk, so saved trips are lost when the service restarts. Real reminder emails need `MAILER=smtp` and an `SMTP_URL`; any free SMTP provider works.
- **Persistent and still free:** the data layer is two small modules (`db.js`, the prepared statements in `app.js` and `reminders.js`). Moving to a hosted Postgres such as Supabase's free tier means replacing those.

## Limits, said plainly

- The rules cover 19 passports and 10 airports as a demonstration, checked against the official site on the date in `rules/india-evisa.json`. Anyone travelling should confirm on the official site.
- Reminders run from an in-process timer. On a host that sleeps, they are sent when it wakes.
