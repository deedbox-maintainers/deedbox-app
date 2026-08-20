# DeedBox

Free, open-source and complete practice management system for law firms: matters and conflicts, time and billing, trust accounting, documents with e-signature and a client portal, workflows and key dates, reporting, email filing, and migration from your previous system. Self-hosted — your practice, your data, on your own systems.

## What it is

- **Matters and parties** — matters, parties, relationships, conflict checking,
  duplicate detection, restricted matters with per-person visibility.
- **Time and billing** — time capture, rates, estimates and budgets, draft
  bills, approval, issue, credit notes, write-offs, disputes, interest,
  reminders and instalment arrangements, statements.
- **Client money** — client and trust ledgers, receipts, payments, transfers,
  earmarks, instruments and dishonours, bank reconciliation with certification,
  and examiner access. Period close obligations, dormancy handling and
  statutory registers are built in but pack-activated: they run to whatever
  your country pack declares, and stay quiet where it declares nothing.
- **Workflow** — matter templates, stages, tasks, key dates and anchors.
- **Documents** — versions, templates, text extraction and search, sharing,
  electronic signature, a client portal, e-mail filing, office accounting.
- **Data import** — clients, matters, time, bills and disbursements from a
  spreadsheet workbook, in a validate-first pass that leaves no residue.

## How it is built

Postgres does the enforcing. Money can never go below zero at the line that
guards it; evidence tables are append-only; every operation writes its own entry
in a hash-chained register; a refusal is recorded even though the refusing
transaction is rolled back. The running application connects as a role that
holds only the privileges each migration grants it, so append-only stores stay
append-only even against application bugs.

- `schema/changes/` — numbered, append-only migration files, applied in order.
- `schema/tests/` — one test file per migration; every invariant lands here and
  blocks release. A migration without its tests does not merge.
- `lib/ops/` — one function per operation. All database access goes through a
  single transaction wrapper that sets the acting identity for that transaction
  and nothing wider.
- `lib/reads/` — read functions for screens, governed by row security.
- `app/` — server-rendered screens (Next.js). No business rule lives in a
  screen.

## Country packs — read this before your first bill

The engine ships **jurisdiction-neutral**: no tax rule, no bank-account
shape, no statutory wording is baked in. A **country pack** supplies those as
typed declarations against the engine's rule points; the firm's database
holds the pack, and the engine consults the firm's **active** version,
falling back to a neutral default wherever the pack is silent.

- `packs/au/` is the Australian pack (GST, BSB-shaped bank identifiers, the
  statutory document wording). Its README covers installing (run the pack
  files in order) and **activating** — a separate, registered act inside the
  product (Settings → Country pack) or via `deedbox.activate_pack(...)`.
- **Until a pack version is active, bills compute no tax at all** and
  documents carry neutral wording. If your firm charges tax, install and
  activate your pack before issuing anything.
- Some catalogued rule points are reserved for future evaluators; a pack may
  declare against them without effect yet. The pack console (Settings →
  Country pack) lists every point.

## Scheduled work — the jobs are inert until something calls them

The application ships twenty-four background jobs — outbound mail dispatch,
document text extraction, session timeouts, interest proposals, dormancy
detection, register hash-chain verification and more — behind
`POST /api/jobs/<job>` guarded by the `DEEDBOX_JOB_SECRET` header. **Nothing
inside the application schedules them.** A fresh installation that skips this
section will look fine and silently never send an email.

- On PostgreSQL with `pg_cron` + `pg_net` + Vault (Supabase's stack), run the
  reference installer: `tools/install-scheduler.sql` (usage in its header).
  It schedules eighteen jobs at proven cadences.
- Anywhere else, any scheduler works — the door is plain HTTPS
  (`curl -X POST -H "x-job-secret: …" …/api/jobs/outbound-dispatch`); the
  cadence table in the installer is the reference.
- Four jobs **write to clients** (payment reminders and instalment
  notifications) and are deliberately not scheduled by default; two more
  need the Microsoft 365 seam bound first. The installer's header names them.

## Requirements

- PostgreSQL, with the `btree_gist`, `fuzzystrmatch`, `pg_trgm` and `unaccent`
  extensions available. The schema installs them into an `extensions` schema.
  It is developed and tested against Supabase's PostgreSQL.
- For scheduled work on the reference path: `pg_cron`, `pg_net` and the Vault
  extension (see "Scheduled work" above; any external scheduler is an
  alternative).
- Node.js 20 or later.

## Running the tests

```
npm install
npm test
```

The suite runs against a real PostgreSQL database — point
`DEEDBOX_DATABASE_URL` at a throwaway one. `tools/validate-chain.py` applies
every migration in order and runs each migration's own test file;
`tools/validate-app.py` applies the chain and then runs the application suite
against it.

⚠️ Those two tools each **create and destroy a real, billable Supabase
project**. They need `SUPABASE_MANAGEMENT_PAT` (or an env file named by
`DEEDBOX_SECRETS_FILE`), and `DEEDBOX_SUPABASE_ORG` unless your account has
exactly one organisation. `DEEDBOX_SUPABASE_REGION` defaults to
`ap-southeast-2`.
