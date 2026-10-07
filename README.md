# Watchtower — Website Change Monitor

Watchtower is a multi-user website-change monitoring MVP. It stores user accounts and monitors in PostgreSQL, uses Redis/BullMQ for durable scheduled checks and notification work, and fetches public pages through a server-side SSRF-conscious HTTP client. The UI shows normalized text snapshots and line-level changes without rendering monitored HTML.

## Architecture

- **Web:** Next.js 15 App Router and React. The dashboard is a client-side workspace; Next route handlers proxy `/api/*`, `/health`, `/ready`, and `/metrics` to the private Express service. Browser code uses same-origin relative URLs.
- **API/auth:** TypeScript + Express 5. Authentication uses Argon2 password hashes, PostgreSQL-backed sessions, email verification/reset tokens, CSRF tokens, rate limits, and user-scoped authorization. Auth.js is not used; this is a server-side equivalent suitable for the current app.
- **Data:** PostgreSQL with Drizzle ORM and checked-in SQL migrations. Users, sessions, monitors, snapshots, changes, plans/subscriptions, Stripe events, preferences, and both change-alert and system-email outboxes are persisted.
- **Background work:** Redis/BullMQ queues, a worker for checks and email delivery, and a scheduler with a Redis leader lock. Stable queue IDs, transactional snapshot/change/outbox writes, Stripe event claims, and provider idempotency keys make retries safe against common duplicate-work cases.
- **Billing and email:** Stripe Checkout, Billing Portal, and signed/idempotent webhooks; Resend verification, password-reset, change-alert, weekly-digest, and persistent-fetch-failure emails. Durable outbox rows, stable queue IDs, and provider idempotency keys protect notification retries. These integrations are disabled or fail closed until configured, except development verification tokens when explicitly enabled.

The codebase was moved from the original Vite prototype to Next.js for the web application. The existing custom CSS was retained instead of introducing Tailwind/shadcn, and the long-running Express API, scheduler, and workers remain separate processes so they can scale and restart independently.

## Run locally

Requirements: Node.js 22+, npm, and Docker Compose.

```bash
cp .env.example .env
# Replace SESSION_SECRET with a unique random value before sharing the environment.
npm ci
npm run dev:stack
```

Open [http://localhost:3000](http://localhost:3000). `dev:stack` starts local PostgreSQL and Redis containers, applies migrations, then starts Next.js, the API, the worker, and the scheduler. The API listens on port 4000; the browser reaches it through the Next.js same-origin proxy. PostgreSQL and Redis are bound to loopback on ports 5432 and 6379.

`npm run dev` starts only the Next.js web server. For isolated work, run `npm run dev:api`, `npm run dev:worker`, and `npm run dev:scheduler` alongside PostgreSQL and Redis. Apply schema migrations with `npm run db:migrate`; generate a new migration after changing the Drizzle schema with `npm run db:generate`.

## Docker Compose

`.env.example` is only for local host-run development with `npm run dev:stack`. That script starts loopback-only PostgreSQL and Redis from `docker-compose.dev.yml`; the sample `wcm` database password and unauthenticated Redis are development-only.

The production/reference `docker-compose.yml` requires explicit `DATABASE_URL` and `REDIS_URL` values and does not start or fall back to local database/cache containers. These URLs must be reachable from the Compose network. Missing, malformed, or loopback production connection URLs fail configuration validation. Do not pass the local `.env.example` values to the production Compose file.

For deployment, use a production secrets manager and set `NODE_ENV=production`, explicit `DATABASE_URL` and `REDIS_URL`, a unique `SESSION_SECRET` of at least 32 characters, HTTPS `APP_ORIGIN` and `APP_BASE_URL` values, `ALLOW_DEV_VERIFICATION_TOKEN=false`, a verified `EMAIL_FROM`, Resend credentials, Stripe secret/webhook keys, and both Stripe recurring price IDs. Compose runs migrations before the API, worker, and scheduler. The Next.js web service is published on `127.0.0.1:3000`; the API is internal to the Compose network. Production configuration rejects insecure public URLs, missing database/Redis settings, and loopback database/Redis endpoints; the API requires email and Stripe settings, and the worker refuses to start without email delivery configured. Ensure the target database and Redis are available before starting Compose. Terminate TLS at a trusted reverse proxy and preserve the original `Host`, `Origin`, and forwarded protocol headers. Set `ENABLE_HSTS=true` when building the production image only after the public app is served exclusively over HTTPS; otherwise configure HSTS at the TLS-terminating edge.

## Quality checks

```bash
npm test              # Vitest unit/security tests
npm run db:check      # validate Drizzle migration history
npm run typecheck     # server and app TypeScript checks
npm run lint          # ESLint
npm run format:check  # Prettier verification
npm run build         # type checks, API build, and Next.js production build
```

Tests cover production configuration validation, generic registration response parity and unique-race/write-failure handling, concurrent checkout-session reuse, Redis-failure handling for auth limits, Stripe invoice-subscription reference parsing, URL parsing and address classification, redirect revalidation, extraction and text normalization against local HTML fixtures, diffs, plan resolution, weekly digest timing, rendered system-email content, stale monitor-job recovery, due-timestamp queue IDs, and stale-fetch commit guards. PGlite-backed PostgreSQL-compatible tests exercise retention SQL and monitor write predicates, including pending-notification protection. The Redis integration tests launch two independent Node processes and verify that auth and reset counters are shared and enforce their configured thresholds; CI starts Redis for these tests, while local runs may set `REDIS_TEST_URL` to enable them. No test contacts arbitrary Internet hosts. Service-backed PostgreSQL integration and Playwright browser end-to-end tests are not included yet.

## Functionality

- Registration, login/logout, email verification, password-reset flow, and persistent server sessions. Registration and password-reset acknowledgements do not disclose whether an address has an account; registration performs the same password-hashing work before the account lookup and applies a response-time floor to reduce obvious timing differences.
- Authentication limits use shared Redis counters per client IP: 10 registration/login attempts per 15 minutes and 5 verification-resend/password-reset attempts per hour. They fail closed: when Redis cannot update a counter, the auth request returns a server error instead of bypassing the limit or falling back to a per-process counter. `/ready` also reports the Redis dependency as unavailable until it recovers.
- Checkout attempts are serialized per user with a renewable Redis lease. A matching pending Stripe session is reused, obsolete open sessions are expired before switching plans, existing paid subscriptions are rejected, and Stripe idempotency keys remain in place for customer/session creation.
- User-owned monitor create/edit/pause/resume/delete flows, status/details, manual checks, change history, and notification preferences.
- Plan limits enforced on the server: Free 5 monitors, Starter 50, Business 250. Plan resolution comes from subscription state, not client input. Snapshot retention is Free 7 days, Starter 30 days, and Business 365 days. Expired current baselines are cleared when pruned so the next successful check starts a fresh baseline; snapshots referenced by pending notifications or digests are retained until delivery.
- Scheduled and manual jobs use the same worker path. A successful check extracts visible page text, normalizes it, calculates a SHA-256 hash, saves a snapshot, and creates a diff/change plus notification-outbox row only when content changes. Fetch or extraction failures never replace the current snapshot or produce a false change. Three exhausted check failures move a monitor into an error state and create an idempotent failure-email outbox item when that preference is enabled. A due monitor is re-queued if its terminal BullMQ job remains failed beyond the failure-persistence grace period.
- Opt-in weekly digests summarize up to 50 changes per user for the prior Monday 09:00 UTC-to-Monday 09:00 UTC period. The scheduler records empty weeks as skipped, so an opted-in account is processed at most once per period without sending empty emails.
- Public-page fetching accepts only HTTP(S) on standard ports, rejects credentials and private/reserved destinations, resolves and validates all DNS answers, pins a validated address for each connection, and repeats validation for every redirect. Requests have bounded redirects, response bytes, timeouts, content types, per-host concurrency/cooldown, and queue retries.
- `/health` is liveness, `/ready` checks PostgreSQL and Redis, and `/metrics` serves Prometheus text only when a bearer `METRICS_TOKEN` is configured. Metrics include monitor/change/system-email outcomes and waiting, active, delayed, and failed job counts for all three BullMQ queues.

The project does **not** run JavaScript from monitored pages, and it never inserts a fetched page's HTML into the dashboard DOM.

## API outline

Authenticated routes are under `/api` and all monitor, change, preference, and usage queries are scoped to the session owner:

- `/api/auth/*` — CSRF bootstrap, register/login/logout, current session, verification, resend, and password reset.
- `/api/monitors` and `/api/monitors/:monitorId` — list/create/read/update/delete, status changes, and manual check.
- `/api/changes` and `/api/changes/:changeId` — history and a single authorized change with its snapshots.
- `/api/settings/notifications` and `/api/usage` — preferences and effective plan/usage.
- `/api/billing/checkout` and `/api/billing/portal` — Stripe-hosted billing flows; `/api/billing/webhook` verifies Stripe signatures.

The Next.js proxy forwards cookies, CSRF/origin headers, query strings, and webhook request bodies to the internal API service. Do not publish port 4000 directly in production.

## Configuration and remaining validation

See `.env.example` for the complete configuration. Do not commit `.env` or real credentials. `ALLOW_DEV_VERIFICATION_TOKEN=true` is for local development only; production configuration rejects it. When Resend is not configured in development, verification and password-reset flows surface their tokens as local-only links rather than delivered email. Stripe billing endpoints return a not-configured response without Stripe settings. Production API and worker processes fail fast rather than silently dropping notification emails when Resend is missing.

Page-change alerts, weekly digests, and persistent-fetch-failure alerts are implemented through durable outboxes and Resend idempotency keys. Weekly digests run after Monday 09:00 UTC and cover the preceding weekly window. In development, queued notifications are marked `not_configured` when Resend is absent; production API and worker processes instead fail fast, so configure the provider before relying on email alerts. The observability implementation provides structured logs and opt-in Prometheus metrics; Sentry/OpenTelemetry exporters, alert rules/dashboards, and on-call wiring are not configured. CI verifies the build and container image but does not deploy to Vercel or a cloud environment; Compose is a reference deployment, with no automated release/rollback workflow. External provider credentials, a reachable Postgres/Redis deployment, public HTTPS/TLS, migration application, webhook delivery, DNS behavior in the target hosting network, email delivery, backups/restore, and production load/security review must be validated in the deployment environment. This repository includes local unit/security tests, but those checks do not substitute for service-backed integration and end-to-end testing.
