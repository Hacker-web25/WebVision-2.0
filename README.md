# WebVision 2.0

**Pravesh** is an unofficial pre-flight companion for India's e-Visa.

**Live demo:** https://webvision-2-0.onrender.com (free hosting: the first load after a quiet period can take about 50 seconds)

## The problem

The official e-Visa site mostly helps after something has gone wrong: a photo is rejected after you submit, a payment is debited but still shows as unpaid, and you have to work out the right visa route yourself. Each of those costs time, and more than three failed payment attempts blocks the application.

## What Pravesh does

| Step | What you get |
| --- | --- |
| Entry plan | Pick a passport, landing airport, purpose and arrival date. You get the route (e-Visa, visa on arrival or embassy), the documents you need, and a warning if the apply-by date has passed |
| Photo and passport check | Your file is checked against the published size, format and shape rules and can be fixed in one click. It never leaves your browser |
| Timeline | Apply-by, e-Arrival Card and landing dates on one line, with optional email reminders |
| Family board | One page for every traveller's progress. Save it and share it by link |
| Payment help | A checklist before paying, a failed-attempt counter, a 4-hour wait timer, and a payment-evidence letter you can copy or download as a PDF |
| Dashboard | Six tabs that cover the journey after the plan. Details are below |

### The dashboard

| Tab | What it does |
| --- | --- |
| Overview | A "ready to fly" list across every tab, the next deadline, and cards for the visa, customs, budget and airport help |
| Visa | Reads the approval email (pasted text, a screenshot or the PDF) and the passport photo page (the two machine-readable lines, checked with their check digits), then compares them field by field. Also: validity and permitted stay, application status with next steps, guidance after a rejection, and a notice when the rules change |
| Customs | Add what you carry. You get a personal checklist under the Baggage Rules, 2026: the free allowance, alcohol and tobacco limits, items to declare, an estimate of duty, and when cash needs a currency declaration |
| Costs | A trip budget in rupees and your own currency, with live exchange rates and a quick converter |
| Airport help | Steps for six situations (pending, rejected, missing document, wrong details, payment failed, refused boarding), a document wallet that works offline, an airline-desk checklist, official contacts and the offline arrival pack |
| In India | Do's and don'ts. Each line is marked as an official rule, with its source, or as general good practice |

It is not the Government of India, it takes no payments and it never submits an application. See "What Pravesh never does" on the page.

There is also an 8-slide pitch deck in [`docs/pitch.html`](docs/pitch.html). Download it and open it in a browser; arrow keys move between slides.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # 15 tests, no network needed
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

**Documents never leave the browser.** The photo and passport scan are cropped, whitened and compressed on the device. The approval email and passport are read on the device too: text recognition (Tesseract.js) and PDF reading (pdf.js) are loaded from a CDN the first time and run in the page. The document wallet uses the browser's own storage. The server has no upload endpoint.

**The server is authoritative for the rules, the page still works without it.** The page renders its own answer instantly, asks `POST /api/plan`, and switches to the server's answer if the two ever differ. A test runs both implementations over every passport, airport, purpose and answer (2,280 combinations) and fails if they disagree.

## API

| Endpoint | What it does |
| --- | --- |
| `GET /api/health` | Liveness, rules version, mail mode |
| `GET /api/rates` | Exchange rates against the rupee, fetched by the server and cached for six hours, so the page never calls a third party |
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

- **Sources for the dashboard.**
  - **Confirmed from the official text:**
    - Customs figures come from the Baggage Rules, 2026 (Notification 14/2026-Customs (N.T.)): ₹25,000 for a foreign tourist, ₹75,000 for others, 2 litres of alcohol, 100 cigarettes, one laptop, and jewellery after a year abroad.
    - Visa validity, stay limits, non-refundable fees, the 3% bank charge and the 6-month passport rule come from the official e-Visa page.
  - **Not confirmed:**
    - The 38.5% duty rate is the old 2016 figure.
    - The currency declaration thresholds were not read from the regulation itself.
    - The official page gives two different figures for the e-Medical Visa, so Pravesh shows both and does not calculate.
    - The page says each of these where it is used.
- **Costs.** Starting values are illustrative and editable. The government visa fee is entered by the traveller, because it depends on nationality.

- The rules cover 19 passports and 10 airports as a demonstration, checked against the official site on the date in `rules/india-evisa.json`. Anyone travelling should confirm on the official site.
- Reminders run from an in-process timer. On a host that sleeps, they are sent when it wakes.
