# Security

Family S is a private family chat application, but it is **not end-to-end encrypted**. Message bodies are stored in Cloudflare D1 so the server can provide search, reply context, and timeline queries.

## Authentication and sessions

- New password hashes use PBKDF2-HMAC-SHA256 with 600,000 iterations, a random 16-byte salt, and a 256-bit output.
- Existing 240,000-iteration hashes remain readable and are upgraded after the next successful login.
- Login verification performs a fixed-cost dummy PBKDF2 operation for unknown users to reduce username-enumeration timing differences for current-format accounts.
- Login throttling uses atomic D1 UPSERT operations for both an IP-wide bucket and an IP+username bucket.
- Password-confirmation operations such as password change and participant deletion use separate atomic per-user/IP rate-limit buckets.
- Expired rate-limit buckets are periodically pruned, and `auth_limits.window_started_at` is indexed so cleanup does not degrade into a full-table scan as the table grows.
- Session tokens contain 256 random bits, are stored only as SHA-256 hashes in D1, and use the `__Host-family_s_session` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`.
- Only `v2.` session tokens are accepted. Sessions issued before the session-hardening release are rejected.
- Users can invalidate every other session or every session.
- Password changes require the current password, revoke old sessions, audit the change, and issue a fresh session.
- The family owner can disable a member account. Disabling also deletes that member's sessions; re-enabling does not create a session.

## Participant withdrawal and deletion

- A member can self-delete only after re-entering the current password and typing the exact confirmation value `DELETE`.
- The sole owner cannot self-delete through the participant endpoint.
- An owner can delete only a `member` account and must re-enter the owner's current password plus `DELETE` confirmation.
- Password-confirmation attempts for deletion are rate-limited independently from normal login attempts.
- Deleting a member cascades through current foreign keys to remove that member's sessions, authored messages, reactions, read marker, blocked-member row, and dependent invitation data.
- References to a deleted participant in `audit_events` use `ON DELETE SET NULL`; the event type and time may remain without the participant identity.
- Application-level deletion must not be described as immediate erasure from D1 Time Travel/disaster-recovery history. Historical database states can remain restorable for the applicable Cloudflare retention period.

## Privacy-safe audit events

`audit_events` is intentionally metadata-only. It may contain:

- event identifier
- event type
- actor user reference
- subject user reference
- timestamp

It must not contain passwords, message bodies, invitation codes, cookies, session tokens, request bodies, or other message content.

Audit event types are allowlisted in application code and enforced again by D1 triggers. Unknown event types are rejected, and `event_type` is immutable after insertion. Foreign-key nulling of actor/subject references after participant deletion remains allowed.

The audit API is owner-only. General administrative audit writes are best-effort so an audit-table problem does not corrupt an already-successful ordinary operation. Destructive/password security routes that depend on auditability use D1 `batch()` so the security mutation and its audit write are transactional together.

## Invitations

- Invitation codes use 192 random bits and only their SHA-256 hashes are stored in D1.
- Invitations are single use and expire after one hour.
- The owner can list active invitations and revoke them before use.

## Browser and API controls

- Mutating requests reject cross-origin `Origin` values and cross-site `Sec-Fetch-Site` values.
- JSON mutation routes require `Content-Type: application/json`.
- Request bodies are capped at 16 KiB before downstream route execution.
- Message creation uses an atomic D1 counter limited to 12 writes per 10-second window per authenticated user, so parallel requests cannot bypass the old count-then-insert check.
- Static CSP uses `base-uri 'none'` and `form-action 'none'`; if client JavaScript fails, password-bearing forms cannot fall back to a normal browser form submission that could place credentials in a URL.
- Static assets remove Pages' default cross-origin access header and set `Cross-Origin-Resource-Policy: same-origin`.
- Static and API responses include no-index directives; this is a privacy signal for crawlers, not an authentication control.
- API responses are normalized by middleware to `Cache-Control: no-store`, CSP, HSTS, frame denial, `nosniff`, no-referrer, same-origin resource policy, and no-index headers. Cloudflare Pages `_headers` does not apply to Pages Functions responses, so these headers are attached in function code as well.
- The service worker never caches `/api/`.
- Message IDs, member IDs, and invite IDs are validated and API routes/methods are explicitly allowlisted.
- Read markers are validated and additionally clamped by D1 triggers.
- Cursor input is length-bounded before Base64/JSON decoding.
- D1 search patterns are bounded by escaped UTF-8 byte length so they stay within Cloudflare D1's `LIKE` pattern limit.
- Pilot security routes emit structured error metadata containing route/method/CF-Ray/error class only; they do not serialize request bodies or credentials into logs.

## Repository and CI controls

- GitHub Actions are pinned to full commit SHAs.
- Checkout uses `persist-credentials: false` and read-only repository permissions.
- CI uses an explicit Ubuntu 24.04 runner instead of `ubuntu-latest` and cancels superseded runs for the same ref.
- CI regression tests cover audit type allowlisting/immutability, rate-limit indexing, health-gate triggers, CSP fallback-form blocking, API response headers, and atomic message-write throttling.
- CI scans both the current tree and complete Git history for common credential signatures and forbidden secret-bearing filenames.
- Real `.env`, `.dev.vars`, private keys, service-account credentials, and API tokens must never be committed.

## Existing deployment upgrade

For an existing D1 database, apply any migrations not already applied:

```text
migrations/0002_security_hardening.sql
migrations/0003_pilot_audit.sql
migrations/0004_runtime_hardening.sql
```

A deployment with the current pilot schema should return:

```json
{"ok":true,"schema":"pilot-v3"}
```

from `GET /api/health`. The health gate now verifies the required tables **and** integrity triggers.

## Remaining operational controls

Repository code cannot enable account-level Cloudflare or GitHub settings by itself. Before an external pilot:

- enable MFA on the Cloudflare account
- use least-privilege Cloudflare access
- enable Pages/Workers observability and review logs for CPU/D1/audit failures
- perform a D1 Time Travel recovery drill on staging
- enable GitHub secret scanning/push protection where available
- protect `main` with required CI checks
- complete the multi-device and withdrawal tests in `PILOT_READINESS.md`

If you discover a vulnerability, do not post family data, credentials, session tokens, message bodies, or invitation codes in a public issue.
