# Real E2E suite (opt-in)

Three browser suites exist, kept apart on purpose:

| Command | Backend | Writes data? | Needs |
| --- | --- | --- | --- |
| `pnpm e2e` | Mocked API and mocked Supabase ([e2e/mock.ts](../e2e/mock.ts)) | No | Nothing |
| `pnpm e2e:live` | Real API, real Supabase Auth, **no credentials** | No | `pnpm dev` running |
| `pnpm e2e:real` | Real web app, real API, real Supabase Auth, real Postgres, real Groq | **Yes** | An isolated test project (below) |

`pnpm e2e:real` does nothing unless you opt in: with `RECALL_REAL_E2E` unset, all 13 tests are reported as **skipped** with the reason. With it set but any prerequisite missing or unsafe, it **fails before starting a browser** and lists every problem. It never silently skips an explicit request.

## What it covers

| File | Tests | Covers |
| --- | --- | --- |
| [auth.real.spec.ts](../e2e/real/auth.real.spec.ts) | 3 | Wrong password rejected by real Supabase; test account signs in, `/api/me` accepts the session, reload keeps it, sign-out ends it; API returns 401 without a session |
| [pipeline.real.spec.ts](../e2e/real/pipeline.real.spec.ts) | 7 | Ingestion through the UI; real Groq extraction (decisions, tasks, owner, deadline); every stored evidence quote is found in the transcript; dashboard status; approving decisions (audit trail); approving a task stays local with no Linear; a later contradicting meeting is flagged, blocks approval, and "Accept new decision" supersedes the old one |
| [linear.real.spec.ts](../e2e/real/linear.real.spec.ts) | 3 | **Double opt-in.** Approve sends exactly one issue; repeated and 4 concurrent syncs never create a second one (checked against Linear itself by the task's `recall-task:<id>` marker); no re-send button once synced |

Real model output varies, so assertions target invariants, not wording. Each run embeds a unique token in its transcripts so earlier runs on the same database cannot affect conflict detection.

## Prerequisites

1. **A disposable Supabase project**, separate from the one in `.env`. Apply the migrations to it:
   `RECALL_ENV_FILE=.env.e2e pnpm db:migrate` (PowerShell: `$env:RECALL_ENV_FILE=".env.e2e"; pnpm db:migrate`).
2. **A dedicated test account** (email + password user) created in that project's Auth settings.
3. **`.env.e2e`** at the repo root, copied from [.env.e2e.example](../.env.e2e.example). It is gitignored. It holds the test project's `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, a `GROQ_API_KEY`, `AUTH_ALLOWED_EMAILS` (must include the test account), and `RECALL_E2E_EMAIL` / `RECALL_E2E_PASSWORD` (or export those two in your shell instead).
4. **Explicit confirmation of the target database**, from your shell:
   `RECALL_E2E_CONFIRM_DB=<user>@<host>:<port>/<db>`. If it is missing or wrong, the error prints the exact value to use (no password).
5. Chromium: `pnpm exec playwright install chromium`.

Then: `RECALL_REAL_E2E=1 RECALL_E2E_CONFIRM_DB=... pnpm e2e:real`.

## Safety design

- **The real `.env` is never read.** The suite starts its own API (port 8788) and web server (port 5174) with `RECALL_ENV_FILE` pointing at `.env.e2e`; the server then loads that file *instead of* the root `.env` and exits if it is missing. `reuseExistingServer` is off, so a running `pnpm dev` is never driven.
- **Isolation checks** ([config.ts](../e2e/real/config.ts), tested in [config.test.ts](../e2e/real/config.test.ts)): refuses if the test `DATABASE_URL` equals the root `.env`'s, if the Supabase project is the same, if the account is not allow-listed, or if the database was not confirmed by name.
- **No credentials in the repo or on disk.** No `storageState`, trace, video or screenshot is written; the session lives in the page's localStorage for the run. Error messages never include secret values.
- **Linear is off by default.** Unless the Linear gate is open, the server is started with `LINEAR_API_KEY` and `LINEAR_TEAM_ID` blanked, so even approving a task cannot create an issue.

## Linear test (creates real issues)

Runs only with all of: `RECALL_REAL_E2E=1`, `RECALL_E2E_LINEAR=1`, `RECALL_E2E_LINEAR_CONFIRM=create-real-linear-issues`, and `LINEAR_API_KEY` + `LINEAR_TEAM_ID` in `.env.e2e` for a **dedicated test team** (refused if it equals the root `.env`'s team). It creates one issue and archives it afterwards (best effort); check the team for leftovers if a run is interrupted.

## Not covered

Token-expiry refresh timing, concurrent approvals from two users, email (there is none), and any run against the real workspace data.
