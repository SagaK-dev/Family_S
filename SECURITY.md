# Security

Family S is a private family chat application, but it is **not end-to-end encrypted**. Message bodies are stored in Cloudflare D1 so the server can provide search, reply context, and timeline queries.

## Authentication and sessions

- New password hashes use PBKDF2-HMAC-SHA256 with 600,000 iterations, a random 16-byte salt, and a 256-bit output.
- Existing 240,000-iteration hashes remain readable and are upgraded after the next successful login.
- Login verification performs a fixed-cost dummy PBKDF2 operation for unknown users to reduce username-enumeration timing differences for current-format accounts.
- Login throttling uses atomic D1 UPSERT operations for both an IP-wide bucket and an IP+username bucket.
- Password-confirmation operations such as password change and participant deletion use separate atomic per-user/IP rate-limit buckets.
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

The audit API is owner-only. General administrative audit writes are best-effort so an audit-table problem does not corrupt an already-successful ordinary operation. Destructive/password security routes that depend on auditability use D1 `batch()` so the security mutation and its audit write are transactional together.

## Invitations

- Invitation codes use 192 random bits and only their SHA-256 hashes are stored in D1.
- Invitations are single use and expire after one hour.
- The owner can list active invitations and revoke them before use.

## Browser and API controls

- Mutating requests reject cross-origin `Origin` values and cross-site `Sec-Fetch-Site` values.
- JSON mutation routes require `Content-Type: application/json`.
- CSP, frame denial, referrer restrictions, `nosniff`, HSTS, and a restrictive Permissions Policy are configured.
- API responses are `Cache-Control: no-store` and the service worker never caches `/api/`.
- Message IDs, member IDs, and invite IDs are validated and API routes/methods are explicitly allowlisted.
- Read markers are validated and additionally clamped by D1 triggers.
- Cursor input is length-bounded before Base64/JSON decoding.
- D1 search patterns are bounded by escaped UTF-8 byte length so they stay within Cloudflare D1's `LIKE` pattern limit.
- New pilot security routes emit structured error metadata containing route/method/CF-Ray/error class only; they do not serialize request bodies or credentials into logs.

## Repository and CI controls

- GitHub Actions are pinned to full commit SHAs.
- Checkout uses `persist-credentials: false` and read-only repository permissions.
- CI scans both the current tree and complete Git history for common credential signatures and forbidden secret-bearing filenames.
- Real `.env`, `.dev.vars`, private keys, service-account credentials, and API tokens must never be committed.

## Existing deployment upgrade

For an existing D1 database, apply any migrations not already applied:

```text
migrations/0002_security_hardening.sql
migrations/0003_pilot_audit.sql
```

A deployment with the current pilot schema should return:

```json
{"ok":true,"schema":"pilot-v2"}
```

from `GET /api/health`.

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
