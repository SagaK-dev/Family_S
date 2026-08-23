# Family S

Family S is a private, family-only web chat designed for a small trusted group. It runs on Cloudflare Pages Functions + D1 and has no runtime npm dependencies.

The application uses a chronological timeline with replies, reactions, search, read markers, owner controls, and single-use invitations. It does not contain public profiles, recommendation feeds, ads, or analytics.

## Important privacy boundary

Family S is **not end-to-end encrypted**. Message bodies are stored as plaintext in the configured Cloudflare D1 database so the server can perform search, reply-context, and timeline queries. Anyone with sufficient Cloudflare/D1 administrative access may be able to read those messages.

Do not describe Family S to pilot participants as zero-knowledge or end-to-end encrypted.

## Features

- username + password authentication
- exactly one family owner, enforced by D1
- first-owner bootstrap protected by `FAMILY_SETUP_SECRET`
- owner-generated single-use invitations that expire after **1 hour**
- active-invite listing and revocation
- member account disable/re-enable with immediate session revocation
- PBKDF2-HMAC-SHA256 password hashing
- 600,000 iterations for current hashes; legacy 240,000-iteration hashes upgrade after successful login
- 30-day random bearer sessions stored only as SHA-256 hashes
- `__Host-family_s_session` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`
- logout current session, logout other devices, and logout all devices
- password change with session rotation
- chronological messages, replies, reactions, edit/delete, and owner pinning
- bounded search compatible with Cloudflare D1's `LIKE` pattern limit
- aggregate read/seen state with database clamping
- PWA shell; `/api/` is never service-worker cached
- public `/api/health` endpoint that checks whether required D1 tables are present

## Pilot polling policy

For a limited pilot, the visible-tab client uses conservative polling rather than the original 2.5-second loop:

- message refresh: every **10 seconds**
- member refresh: every **60 seconds**
- read-marker write: only when the newest message timestamp advances
- polling pauses while the tab is hidden and while search/pinned views are active

The request-budget regression test models three users keeping the chat visible for four hours at about **5,046 idle refresh requests**, before user-generated actions. This is a planning model, not a production load test.

## Architecture

```text
Browser
  ├─ index.html / styles.css / app.js
  ├─ 10 s visible-tab message polling
  ├─ 60 s member polling
  └─ service worker for static shell only
          │
          ▼
Cloudflare Pages Functions
  ├─ functions/api/_middleware.js
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
  └─ auth_limits
```

`shared/chat.js` contains validation, D1-safe search-pattern construction, cursor handling, reaction aggregation, and timeline processing. `shared/pilot.js` contains the pilot polling constants and request-budget helpers.

## Security model

### Passwords and sessions

- current password hashes: PBKDF2-HMAC-SHA256, 600,000 iterations, random 16-byte salt, 256-bit output
- legacy 240,000-iteration hashes remain readable and are upgraded after successful login
- unknown-user login attempts perform a dummy PBKDF2 operation to reduce username-enumeration timing differences
- login throttling uses atomic D1 counters for both IP-wide and IP+username buckets
- session tokens contain 256 random bits and only their SHA-256 hashes are stored in D1
- only v2 session tokens are accepted
- users can revoke other sessions or every session
- password changes revoke all old sessions and issue a fresh session
- owner can disable a member; disabling immediately deletes that member's sessions

### Browser and API controls

- mutating requests reject cross-origin `Origin` and cross-site `Sec-Fetch-Site`
- API routes and methods are explicitly allowlisted
- request bodies are size-bounded
- message/invite IDs are validated
- search patterns are checked against D1's 50-byte `LIKE` pattern limit after SQL escaping and UTF-8 encoding
- CSP, HSTS, frame denial, `nosniff`, referrer restrictions, COOP, and restrictive Permissions Policy are configured
- API responses use `Cache-Control: no-store`
- service worker excludes `/api/`

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

Create a D1 database and apply `schema.sql`.

### Existing D1 database

Apply:

```text
migrations/0002_security_hardening.sql
```

Re-running the idempotent `schema.sql` is also supported for the current schema additions.

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

A ready deployment returns HTTP 200 with:

```json
{"ok":true,"schema":"pilot-v1"}
```

If the D1 binding exists but required tables are missing, the endpoint returns HTTP 503. It intentionally exposes no row counts, usernames, messages, or other family data.

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

Current automated coverage includes:

- username/display-name/password/message validation
- D1-safe ASCII, Japanese, and escaped-wildcard search bounds
- reaction allowlisting
- cursor round-trip/rejection
- timeline ordering/deduplication/page bounds
- route/method allowlisting, including the read-only health endpoint
- owner/member control routes
- legacy/current password-hash parsing
- host-only session cookie name
- pilot request-budget regression
- read-marker write deduplication
- current-tree and full-Git-history secret scanning

## Pilot readiness

A green GitHub Actions run verifies the source, but it does **not** prove the target Cloudflare account is ready.

Before inviting external households, complete `PILOT_READINESS.md`, including:

- actual Pages + D1 deployment and `/api/health`
- production-like login/register/password-change measurements
- check for Workers CPU-limit errors in Pages Functions logs
- owner/member tests on at least two devices or browsers
- invite reuse/revocation tests
- session revocation and member-disable tests
- D1 Time Travel restore drill on a disposable staging/pilot database
- Cloudflare MFA and least-privilege access
- GitHub push protection/secret scanning where available
- protected `main` with required CI checks

Because current password hashing uses 600,000 PBKDF2 iterations, do not assume the Workers Free 10 ms CPU allowance is sufficient. Use a suitable Cloudflare plan for the pilot unless measurements in the actual deployment demonstrate reliable operation.

## Project structure

```text
Family_S/
├─ app.js
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
│  └─ 0002_security_hardening.sql
├─ shared/
│  ├─ chat.js
│  └─ pilot.js
├─ functions/
│  └─ api/
│     ├─ _middleware.js
│     └─ [[path]].js
├─ scripts/
│  ├─ benchmark-password.mjs
│  └─ check-secrets.mjs
├─ tests/
│  └─ chat.test.js
└─ .github/workflows/ci.yml
```

## Scope

Family S is not a clone of X/Twitter. Public X/Twitter architecture was used only as study material for pipeline decomposition, feed ordering, filtering, conversation context, and pagination. No proprietary systems, private data, UI assets, brand elements, or source text are copied.