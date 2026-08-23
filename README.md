# Family S

Family S is a private, family-only web chat for a small trusted group. It runs on Cloudflare Pages Functions + D1 and has no runtime npm dependencies.

It provides a chronological family timeline with replies, reactions, search, read markers, owner controls, single-use invitations, participant withdrawal/data deletion, and a privacy-safe administrative audit trail.

## Privacy boundary

Family S is **not end-to-end encrypted**. Message bodies are stored as plaintext in Cloudflare D1 so the server can perform search, reply-context, and timeline queries. Anyone with sufficient Cloudflare/D1 administrative access may be able to read those messages.

Application-level deletion also does not imply immediate erasure from D1 Time Travel/disaster-recovery history. Pilot consent/privacy text must describe that retention accurately.

## Security highlights

- PBKDF2-HMAC-SHA256 passwords at 600,000 iterations; legacy 240,000-iteration hashes upgrade after successful login
- unknown-user login attempts perform dummy PBKDF2 work to reduce username-enumeration timing differences
- atomic D1 login throttles for IP-wide and IP+username buckets
- dedicated rate limits for password-confirmation operations
- `__Host-family_s_session` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`
- session tokens contain 256 random bits and only SHA-256 hashes are stored
- **maximum 8 active sessions per user**; older sessions are pruned transactionally when a new session is issued
- all core auth endpoints use exact Pages Function routes (`me`, `bootstrap`, `register`, `login`, logout variants, password change, account deletion)
- owner-generated invites use 192 random bits, expire after 1 hour, are single use, and store only a hash
- invite registration uses a unique temporary `invite_claims` record inside one D1 batch so concurrent registration and username failures cannot leave a half-consumed invite
- participant self-deletion and owner-assisted member deletion require password re-authentication plus explicit `DELETE`
- member disable immediately revokes that member's sessions
- message creation has an atomic D1 limiter: 12 attempts per authenticated user per 10-second window
- JSON request bodies are capped at 16 KiB before downstream execution
- search is bounded by D1's 50-byte `LIKE` pattern limit after escaping and UTF-8 encoding
- audit event types are allowlisted in application code and D1
- audit history is append-only at the D1 layer; arbitrary updates/deletes are rejected, while participant deletion may anonymize actor/subject references to `NULL`
- API responses use no-store, restrictive CSP, COOP, CORP, Permissions Policy, HSTS, frame denial, `nosniff`, no-referrer, and no-index headers
- service worker never caches `/api/`
- CI scans the current tree and complete Git history for common credential leaks

## Pilot polling policy

For a limited pilot:

- messages refresh every **10 seconds** while the tab is visible
- members refresh every **60 seconds**
- read markers are written only when the newest message advances
- polling pauses when the tab is hidden and during search/pinned views

The source-level request-budget regression models 3 users leaving the chat visible for 4 hours at about **5,046 idle refresh requests**, before user-generated actions. This is a planning model, not a production load test.

## Architecture

```text
Browser / PWA
        │
        ▼
Cloudflare Pages Functions
  ├─ functions/api/_middleware.js
  ├─ functions/api/_security.js
  ├─ functions/api/health.js
  ├─ functions/api/audit.js
  ├─ functions/api/auth/*.js       # exact auth routes
  ├─ functions/api/members/[id]/delete.js
  └─ functions/api/[[path]].js    # remaining chat API
        │
        ▼
Cloudflare D1
  ├─ users
  ├─ sessions
  ├─ blocked_users
  ├─ invites
  ├─ invite_claims
  ├─ messages
  ├─ reactions
  ├─ reads
  ├─ auth_limits
  └─ audit_events
```

`shared/chat.js` contains validation, D1-safe search construction, cursor handling, reaction aggregation, and timeline processing. `shared/pilot.js` contains pilot polling constants and request-budget helpers.

## Audit and participant deletion

`audit_events` contains only event metadata:

- event id/type
- actor/subject user references when they still exist
- timestamp

It must never contain passwords, message bodies, invite codes, cookies, session tokens, or request bodies.

D1 triggers reject unknown audit event types, prevent event type/time/id modification, and reject audit-row deletion. The only user-reference transition allowed after insertion is non-null → `NULL`, which permits `ON DELETE SET NULL` to anonymize a participant after account deletion.

Deleting a member cascades through the current foreign keys to remove that participant's sessions, authored messages, reactions, read marker, blocked-member row, dependent invitations, and temporary invite claims. D1 Time Travel can still retain a restorable historical database state during its retention window.

## Cloudflare deployment

### New D1 database

Create a D1 database and apply the current `schema.sql`.

### Existing D1 database

Apply every migration not already present, in order:

```text
migrations/0002_security_hardening.sql
migrations/0003_pilot_audit.sql
migrations/0004_runtime_hardening.sql
migrations/0005_session_audit_hardening.sql
```

Migration `0005_session_audit_hardening.sql` adds:

- `invite_claims` for concurrency-safe invite consumption
- the session-pruning/lifecycle foreign-key indexes
- append-only audit update/delete guards

Bind the D1 database as `FAMILY_DB` and store `FAMILY_SETUP_SECRET` as an encrypted Cloudflare secret. Never commit the real secret.

### Health check

After deployment:

```text
GET /api/health
```

A correctly upgraded pilot database returns HTTP 200:

```json
{"ok":true,"schema":"pilot-v4"}
```

HTTP 503 means the binding or one of the required tables, triggers, or indexes is missing. The endpoint exposes no family row data.

## Verification

Node.js 22+:

```bash
npm test
npm run check
npm run benchmark:password
npm run security:check
npm run security:history
```

`npm run check` recursively syntax-checks JavaScript/MJS under the app, `shared/`, `functions/`, `scripts/`, and `tests/`, validates the manifest and `_routes.json`, and checks the migration set. New route files therefore cannot silently fall outside the syntax gate.

Automated coverage includes validation/search/cursors/reactions, explicit routes, oversized-body rejection, password hash migration, session-cookie policy, polling budget, atomic message throttling, audit allowlisting/immutability, append-only audit guards, session cap, exact auth routes, concurrency-safe invitation claims, security headers, required lifecycle indexes, and `pilot-v4` health integrity.

The PBKDF2 benchmark confirms the 600k path actually executes in CI. Its wall-clock time is **not** a substitute for Cloudflare Workers CPU measurement.

## Pilot readiness

A green repository CI is necessary but not sufficient for external households. Complete [PILOT_READINESS.md](PILOT_READINESS.md), including:

- apply migration 0005 to an existing deployment
- verify live `/api/health` returns `pilot-v4`
- measure login/register/password-change/delete CPU behavior in the actual Pages deployment
- inspect Functions logs for CPU-limit, D1, and audit failures
- verify actual static/API response headers
- run owner/member multi-device E2E
- test simultaneous invitation registration and session-cap behavior
- test participant withdrawal and append-only audit behavior on staging
- perform a D1 Time Travel recovery drill
- enable Cloudflare MFA and least-privilege access
- enable GitHub secret scanning/push protection where available
- protect `main` with required CI checks

Because password hashing uses 600,000 PBKDF2 iterations, do not assume the Workers Free CPU allowance is sufficient. Measure it in the actual deployment or use an appropriate paid plan for the pilot.

## Project structure

```text
Family_S/
├─ app.js
├─ pilot-controls.js
├─ sw.js
├─ _headers
├─ _routes.json
├─ schema.sql
├─ SECURITY.md
├─ PILOT_READINESS.md
├─ migrations/
│  ├─ 0002_security_hardening.sql
│  ├─ 0003_pilot_audit.sql
│  ├─ 0004_runtime_hardening.sql
│  └─ 0005_session_audit_hardening.sql
├─ shared/
├─ functions/api/
│  ├─ _middleware.js
│  ├─ _security.js
│  ├─ [[path]].js
│  ├─ health.js
│  ├─ audit.js
│  ├─ auth/
│  │  ├─ me.js
│  │  ├─ bootstrap.js
│  │  ├─ register.js
│  │  ├─ login.js
│  │  ├─ logout.js
│  │  ├─ logout-others.js
│  │  ├─ logout-all.js
│  │  ├─ change-password.js
│  │  └─ delete-account.js
│  └─ members/[id]/delete.js
├─ scripts/
│  ├─ check-syntax.mjs
│  ├─ benchmark-password.mjs
│  └─ check-secrets.mjs
└─ tests/
```

See [SECURITY.md](SECURITY.md) for the security boundary and [PILOT_READINESS.md](PILOT_READINESS.md) for the pilot go/no-go checklist.
