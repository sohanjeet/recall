# Recall browser QA report

Date: 2026-11-01 · Browser: Chromium 1243 (Playwright 1.64.1, `@axe-core/playwright` 4.14.0) · OS: Windows 11 · Node 24.19 · pnpm 12.16.1
App under test: `apps/web` (Vite dev server, `:5173`) with the Express API on `:8787` running for the live checks.

## Read this first: what is real and what is mocked

No test account credentials exist in this repository or its `.env`, so **no authenticated session against the real Supabase project was used**. The signed-in walkthrough therefore runs the real web app against a **mocked API and mocked Supabase Auth** ([e2e/mock.ts](../e2e/mock.ts)), installed through Playwright route interception. The mock holds fixture data shaped like a "Project Atlas" workspace. It is not read from, and never written to, the real Project Atlas records, Groq, Linear, or the production database.

| Area | Coverage | Source |
| --- | --- | --- |
| Frontend rendering, routing, forms, validation, state transitions, responsive layout, keyboard, axe | **Real** app code in a real browser | `qa.spec.ts` |
| API payloads, approval/conflict/sync state changes | **Mocked** (a small in-memory model of the server contract) | `mock.ts` |
| API health, `401` on protected routes, public auth config, login redirect, Supabase rejecting an unknown account | **Real** (live server + real Supabase Auth, read-only, no credentials) | `live.spec.ts` |
| Groq extraction, conflict detection, Linear issue creation, email | **Not exercised in a browser**; covered only by the server unit tests (`pnpm test`) | – |

Screenshots: every image except `portfolio/login.png` is rendered from mocked data. `login.png` is the real login page from the real server. The Linear link in the screenshots (`linear.app/example/…`) is a fixture; **no Linear issue was created and no live Linear sync is shown as verified.**

## Pages visited

Every route in [App.tsx](../apps/web/src/App.tsx) was visited (10 distinct screens/states):

| Route | Screen |
| --- | --- |
| `/login` | Sign in (plus unreachable, unconfigured and expired-session variants) |
| `/` | Meetings dashboard |
| `/meetings/new` | New meeting |
| `/meetings/:id` | Meeting detail: analyzed with open conflicts, analyzed with resolved conflicts, failed analysis, not analyzed, not found |
| `/approvals` | Approvals (conflicts, proposed decisions, proposed tasks, Linear sync) |
| `/reminders` | Reminders tab and Weekly digests tab |
| `/people` | People (a placeholder page; the app says per-person pages are not built) |
| `*` | In-app not-found |

## Results

**Mocked suite (`pnpm e2e`): 59 passed, 0 failed, 0 skipped.** Live suite (`pnpm e2e:live`): **5 passed**. Screenshot capture (`pnpm e2e:screenshots`): 26 capture tests, all passed.

| Scenario group | Tests | Result |
| --- | --- | --- |
| A. Authentication: protected redirect, disabled submit, invalid credentials, native email validation, persistence over reload, sign out, 401 and 403 handling | 6 | Pass |
| B. Dashboard: populated list, empty state, slow loading, API down with retry, not-found route, unknown meeting | 6 | Pass |
| C. New meeting: required fields, speaker detection and correction, success, server error, 50k-character limit, busy state | 6 | Pass |
| D. Analysis display: decisions, tasks, owner, due date, unresolved/none due, evidence quotes, no-evidence message, ambiguities, failed analysis + retry, progress message, empty results | 4 | Pass |
| E/F. Approvals and conflicts: blocked approval on a clear conflict, uncertain conflict, accept-new, keep-old, dismiss, resolved-history outcomes, struck-through side, no stale warning after resolution, duplicate approval refused, approve/reject, audit history, edit form, empty queue | 9 | Pass |
| G. Tasks and Linear: approve, synced link, no re-send for synced, failed sync and retry, sync error inline, Linear-not-configured | 3 | Pass |
| H. Reminders and digests: inbox, preview, generate, mark read, window selector, empty states, owner grouping, unknown owner flagged, tab keyboard navigation, no delivery claims | 7 | Pass |
| I. Edge cases: long titles, health unreachable, API unreachable at start, sign-in unconfigured | 4 | Pass |
| Responsive: 5 viewports × 10 routes (overflow, clipped controls, console errors) + mobile navigation | 6 | Pass |
| Keyboard and accessibility: skip link, visible focus, axe on 6 pages | 8 | Pass |

Behaviours confirmed (mocked data): reminders and digests say "In-app only", items read "Generated · not delivered" / "Saved · not delivered", and the word "Delivered" never appears; a resolved conflict no longer shows the "stays in effect until you resolve this" warning; only the superseded side (kept-new) or the rejected side (kept-old) is struck through, and a dismissed conflict strikes neither.

## Screenshots

12 portfolio images (`docs/screenshots/portfolio/`, 1440×900, full-page where noted) and 34 QA images (`docs/screenshots/qa/`).

| Portfolio file | State | Data |
| --- | --- | --- |
| `login.png` | Real sign-in page | Live |
| `dashboard.png` | Meetings list | Mocked |
| `new-meeting.png` (full page) | Filled form with detected speakers | Mocked |
| `ai-extraction.png` (full page) | Decisions, tasks, owners, deadlines, evidence quotes, ambiguity | Mocked |
| `decisions.png` (full page) | Approved decisions with evidence | Mocked |
| `conflict-detected.png` | Open clear and uncertain conflicts, old vs new | Mocked |
| `approvals.png` | Proposed decisions with approve/edit/reject | Mocked |
| `tasks.png` | Proposed tasks | Mocked |
| `linear-sync.png` | Synced and failed-sync tasks | Mocked |
| `conflict-resolved.png` | Conflict after "Accept new decision" | Mocked |
| `reminders.png` (full page) | In-app-only notice, preview, inbox | Mocked |
| `weekly-digest.png` (full page) | Digest grouped by owner | Mocked |

QA images: `tablet-*`, `mobile-*`, `small-mobile-*` (dashboard, approvals, meeting detail, new meeting, reminders; plus `mobile-login`), `validation-*`, `empty-*`, `loading-meetings`, `failure-*`, `conflict-*` (uncertain, keep-old, dismissed, resolved history), `linear-sync-failed-retry`, `linear-not-configured`.

Not captured: the browser's native required-field validation bubble (it is not part of page content in headless capture; the behaviour is asserted in tests instead).

## Browser console errors

None on any route at any of the 5 viewports in the mocked suite (all routes, asserted). Intentional failure injections (aborted requests, 4xx/5xx) produce the browser's own "Failed to load resource" lines, which the tests allow only in those scenarios.

## Responsive layout

1440×900, 1280×800, 768×1024, 390×844 and 375×812: no horizontal page overflow and no control positioned outside the viewport on any of the 10 routes. Long decision and task titles wrap. Mobile navigation reaches all five pages.

## Accessibility

- axe-core (WCAG 2.0/2.1 A and AA): **0 serious or critical violations** on login, meetings, new meeting, meeting detail, approvals and reminders. Run at 1440×900 only.
- Skip link is first in tab order and moves focus to `#main`.
- Every focusable control reached in the first 25 Tab stops on `/approvals` shows a focus indicator.
- Tabs on Reminders & digests respond to arrow keys.

## Bugs and observations

No functional bug was found, so no application code was changed. Two low-severity UX findings, from code inspection plus the screenshots:

| # | Severity | Finding | Reproduce |
| --- | --- | --- | --- |
| 1 | Low | Meeting status label "Drafts ready" is shown for every analyzed meeting, including ones whose decisions and tasks are all approved, so it can read as "still needs review". | Open the dashboard with an analyzed meeting whose drafts are all approved (fixture "Atlas kickoff"): the tag still says "Drafts ready". Source: `STATUS_LABEL.extracted` in [MeetingsPage.tsx](../apps/web/src/pages/MeetingsPage.tsx). |
| 2 | Low | At 375–390 px the primary navigation scrolls sideways and "Reminders & digests" is cut off at the edge with no scroll affordance (a fade or arrow), so the last items are easy to miss. | Open `/` at 375×812. See `qa/small-mobile-dashboard.png`. |

Cosmetic: on mobile the meeting rows are indented slightly more than the page heading.

## Remaining untested

- An authenticated walkthrough against the real backend and database (needs a dedicated allow-listed test account).
- Real Groq extraction and conflict detection through the UI, real Linear issue creation, real session refresh and token expiry with Supabase.
- The actual Project Atlas history (deliberately not touched).
- Firefox and WebKit, dark mode, and print.
- axe at tablet and mobile sizes; screen-reader behaviour; keyboard focus order on pages other than approvals.
- Concurrent approvals from two sessions, multi-tab sign-out, very large lists.

## Re-running

```bash
pnpm e2e              # mocked QA suite; starts the Vite dev server itself
pnpm e2e:live         # read-only checks; needs `pnpm dev` running
pnpm e2e:screenshots  # regenerates docs/screenshots; login.png needs `pnpm dev` running
```

If Playwright's pinned Chromium is not installed, run `pnpm exec playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_PATH` to an existing Chromium executable.
