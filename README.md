# Family S

Family S is a private, family-only web chat for a small trusted group. It runs on Cloudflare Pages Functions + D1 and has no runtime npm dependencies.

The application uses a chronological timeline with replies, reactions, search, read markers, owner controls, single-use invitations, participant withdrawal/data deletion, and a privacy-safe administrative audit trail. It does not contain public profiles, recommendation feeds, ads, or analytics.

## Important privacy boundary

Family S is **not end-to-end encrypted**. Message bodies are stored as plaintext in the configured Cloudflare D1 database so the server can perform search, reply-context, and timeline queries. Anyone with sufficient Cloudflare/D1 administrative access may be able to read those messages.

Do not describe Family S to pilot participants as zero-knowledge or end-to-end encrypted. Application-level deletion also does not imply immediate erasure from D1 Time Travel/disaster-recovery history; the pilot privacy notice must describe that retention accurately.

## Features

- username + password authentication
- exactly one family owner, enforced by D1
- first-owner bootstrap protected by `FAMILY_SETUP_SECRET`
- owner-generated single-use invitations that expire after **1 hour**
- active-invite listing and revocation
- member disable/re-enable with immediate session revocation
- participant self-service withdrawal/data deletion with password re-authentication and explicit `DELETE` confirmation
- owner-confirmed participant deletion for withdrawal cases where self-service is unavailable
- owner-only audit-log view for security/administrative events
- audit events never store passwords, message bodies, invitation codes, cookies, session tokens, or request bodies
- PBKDF2-HMAC-SHA256 password hashing, 600,000 iterations for current hashes
- legacy 240,000-iteration hashes upgrade after successful login
- 30-day random bearer sessions stored only as SHA-256 hashes
- `__Host-family_s_session` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`
- logout current session, logout other devices, and logout all devices
- password change with re-authentication, rate limiting, session rotation, and audit logging
- sensitive password-confirmation actions have separate per-user/IP rate limits
- chronological messages, replies, reactions, edit/delete, and owner pinning
- bounded search compatible with Cloudflare D1's `LIKE` pattern limit
- aggregate read/seen state with database clamping
- PWA shell; `/api/` is never service-worker cached
- public `/api/health` endpoint that verifies the required pilot D1 schema

## Pilot polling policy

For a limited pilot, the visible-tab client uses conservative polling:

- message refresh: every **10 seconds**
- member refresh: every **60 seconds**
- read-marker write: only when the newest message timestamp advances
- polling pauses while the tab is hidden and while search/pinned views are active

The request-budget regression test models three users keeping the chat visible for four hours at about **5,046 idle refresh requests**, before user-generated actions. This is a planning model, not a production load test.

## Architecture

```text
Browser
  ├─ index.html / styles.css / app.js
  ├─ pilot-controls.js
  ├─ 10 s visible-tab message polling
  ├─ 60 s member polling
  └─ service worker for static shell only
          │
          ▼
Cloudflare Pages Functions
  ├─ functions/api/_middleware.js
  ├─ functions/api/_security.js
  ├─ functions/api/health.js
  ├─ functions/api/audit.js
  ├─ functions/api/auth/change-password.js
  ├─ functions/api/auth/delete-account.js
  ├─ functions/api/auth/logout-all.js
  ├─ functions/api/members/[id]/delete.js
  └─ functions/api/[[path]].js
          │
          ▼
Cloudflare D1
  ├─ users
  ├─ sessions
  ├─ blocked_users
  ├─ invites
  ├─ messages
  ├─ reactions
  ├─ reads
  ├─ auth_limits
  └─ audit_events
```

`shared/chat.js` contains validation, D1-safe search-pattern construction, cursor handling, reaction aggregation, and timeline processing. `shared/pilot.js` contains pilot polling constants and request-budget helpers.

## Security model

### Passwords and sessions

- current password hashes: PBKDF2-HMAC-SHA256, 600,000 iterations, random 16-byte salt, 256-bit output
- legacy 240,000-iteration hashes remain readable and upgrade after successful login
- unknown-user login attempts perform a dummy PBKDF2 operation to reduce username-enumeration timing differences
- login throttling uses atomic D1 counters for both IP-wide and IP+username buckets
- password-confirmation operations such as password change and account deletion use additional atomic rate-limit buckets
- session tokens contain 256 random bits and only their SHA-256 hashes are stored in D1
- only v2 session tokens are accepted
- users can revoke other sessions or every session
- password changes revoke old sessions and issue a fresh session
- owner can disable a member; disabling immediately deletes that member's sessions

### Participant deletion

A member can delete their own account by re-entering the current password and typing `DELETE`. The sole owner cannot self-delete through this endpoint.

The owner can delete a member after re-entering the owner password and typing `DELETE`. This is intended for confirmed participant-withdrawal requests.

Deleting a member row causes the current foreign-key rules to remove that participant's sessions, authored messages, reactions, read marker, blocked-member record, and dependent invitation data. References from surviving audit rows are set to `NULL` so a minimal event/timestamp history can remain without retaining the deleted participant identity.

D1 Time Travel may still hold a restorable historical database state for its configured retention window. See `PILOT_READINESS.md`.

### Privacy-safe audit log

`audit_events` stores only:

- event identifier
- event type
- actor user reference when still present
- subject user reference when still present
- event timestamp

The owner-only `GET /api/audit` endpoint resolves current display names for convenience. It does not return credentials, message contents, invite codes, session values, or request bodies.

### Browser and API controls

- mutating requests reject cross-origin `Origin` and cross-site `Sec-Fetch-Site`
- API routes and methods are explicitly allowlisted
- JSON endpoints require `Content-Type: application/json`
- request bodies are size-bounded
- message/invite/member IDs are validated
- search patterns are checked against D1's 50-byte `LIKE` pattern limit after SQL escaping and UTF-8 encoding
- CSP, HSTS, frame denial, `nosniff`, referrer restrictions, COOP, and restrictive Permissions Policy are configured
- API responses use `Cache-Control: no-store`
- service worker excludes `/api/`
- security-route errors use structured logs without serializing request bodies or credentials

See [SECURITY.md](SECURITY.md) for the security boundary and [PILOT_READINESS.md](PILOT_READINESS.md) for the pilot go/no-go checklist.

## Secrets

Never commit real credentials. `.gitignore` excludes `.dev.vars`, `.env`, private keys, service-account files, and common credential files. CI scans both the current tree and Git history.

Required production secret:

```text
FAMILY_SETUP_SECRET
```

Use a long random value stored as a Cloudflare encrypted secret. Never put the real value in source, HTML, a public environment variable, or a GitHub issue.

## Cloudflare deployment

### New D1 database

Create a D1 database and apply the current `schema.sql`.

### Existing D1 database

Apply any migrations not yet present, including:

```text
migrations/0002_security_hardening.sql
migrations/0003_pilot_audit.sql
```

Re-running the idempotent schema additions is also supported, but migration state should still be recorded operationally.

### Bindings

Bind D1 to the Pages project as:

```text
FAMILY_DB
```

Set `FAMILY_SETUP_SECRET` as an encrypted Cloudflare secret.

### Health check

After deployment, request:

```text
GET /api/health
```

A pilot-ready schema returns HTTP 200 with:

```json
{"ok":true,"schema":"pilot-v2"}
```

If the D1 binding exists but a required table is missing, the endpoint returns HTTP 503. It intentionally exposes no row counts, usernames, messages, or other family data.

### Observability

Enable Pages/Workers logs before inviting pilot participants. For a small pilot, `PILOT_READINESS.md` recommends beginning with full head sampling so CPU-limit, D1, authentication, and audit-write failures can be diagnosed. Logs must not be used to record message bodies, passwords, invitation codes, cookies, or request payloads.

## Verification

Node.js 22+ is used for repository checks.

```bash
npm test
npm run check
npm run benchmark:password
npm run security:check
npm run security:history
```

The password benchmark confirms that the 600k PBKDF2 path actually runs in CI; its elapsed wall-clock time is **not** a substitute for Cloudflare Workers CPU measurements.

Automated coverage includes:

- username/display-name/password/message validation
- D1-safe ASCII, Japanese, and escaped-wildcard search bounds
- reaction allowlisting
- cursor round-trip/rejection
- timeline ordering/deduplication/page bounds
- exact route/method allowlisting for health, audit, withdrawal, and member lifecycle controls
- legacy/current password-hash parsing
- host-only session cookie name
- pilot request-budget regression
- read-marker write deduplication
- audit schema/migration invariants
- current-tree and full-Git-history secret scanning

## Pilot readiness

A green GitHub Actions run verifies source-level behavior, but it does **not** prove the target Cloudflare account is ready.

Before inviting external households, complete `PILOT_READINESS.md`, including:

- actual Pages + D1 deployment and `pilot-v2` health check
- production-like login/register/password-change/self-delete/member-delete measurements
- check for Workers CPU-limit and D1 errors in Pages Functions logs
- owner/member tests on at least two devices or browsers
- invite reuse/revocation tests
- session revocation and member-disable tests
- audit-log access/privacy tests
- participant withdrawal/data deletion drill
- D1 Time Travel restore drill on a disposable staging/pilot database
- Cloudflare MFA and least-privilege access
- GitHub push protection/secret scanning where available
- protected `main` with required CI checks

Because current password hashing uses 600,000 PBKDF2 iterations, do not assume the Workers Free 10 ms CPU allowance is sufficient. Use a suitable Cloudflare plan for the pilot unless measurements in the actual deployment demonstrate reliable operation.

## Project structure

```text
Family_S/
├─ app.js
├─ pilot-controls.js
├─ index.html
├─ styles.css
├─ icon.svg
├─ manifest.webmanifest
├─ sw.js
├─ _headers
├─ schema.sql
├─ SECURITY.md
├─ PILOT_READINESS.md
├─ migrations/
│  ├─ 0002_security_hardening.sql
│  └─ 0003_pilot_audit.sql
├─ shared/
│  ├─ chat.js
│  └─ pilot.js
├─ functions/
│  └─ api/
│     ├─ _middleware.js
│     ├─ _security.js
│     ├─ [[path]].js
│     ├─ health.js
│     ├─ audit.js
│     ├─ auth/
│     │  ├─ change-password.js
│     │  ├─ delete-account.js
│     │  └─ logout-all.js
│     └─ members/[id]/delete.js
├─ scripts/
│  ├─ benchmark-password.mjs
│  └─ check-secrets.mjs
├─ tests/
│  └─ chat.test.js
└─ .github/workflows/ci.yml
```

## Scope

Family S is not a clone of X/Twitter. Public X/Twitter architecture was used only as study material for pipeline decomposition, feed ordering, filtering, conversation context, and pagination. No proprietary systems, private data, UI assets, brand elements, or source text are copied.
