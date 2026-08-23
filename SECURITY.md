# Security

Family S is a private family chat application, but it is **not end-to-end encrypted**. Message bodies are stored in Cloudflare D1 so the server can provide search, reply context, and timeline queries.

## Authentication and sessions

- New password hashes use PBKDF2-HMAC-SHA256 with 600,000 iterations, a random 16-byte salt, and a 256-bit output.
- Existing 240,000-iteration hashes remain readable and upgrade after the next successful login.
- Unknown-user login verification performs fixed-cost dummy PBKDF2 work to reduce username-enumeration timing differences.
- Login throttling uses atomic D1 UPSERT operations for both an IP-wide bucket and an IP+username bucket.
- Password-confirmation operations such as password change and participant deletion use separate atomic per-user/IP rate-limit buckets.
- Stale rate-limit buckets are pruned and `auth_limits.window_started_at` is indexed.
- Session tokens contain 256 random bits and are stored only as SHA-256 hashes.
- Sessions use `__Host-family_s_session` with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`.
- Only `v2.` session tokens are accepted.
- A user can have at most **8 active sessions** after session issuance. New session creation transactionally removes expired sessions and prunes the user's older sessions before inserting the new one.
- Users can invalidate every other session or every session.
- Password changes require the current password, revoke old sessions, audit the change, and issue a fresh capped session.
- The family owner can disable a member account; disabling deletes that member's sessions.
- Core authentication endpoints are implemented as exact Pages Function routes so critical auth behavior does not depend on the general chat catch-all route.

## Invitations and registration

- Invitation codes use 192 random bits and only their SHA-256 hashes are stored in D1.
- Invitations are single use and expire after one hour.
- The owner can list active invitations and revoke them before use.
- Registration uses a unique temporary `invite_claims` row inside a D1 `batch()` transaction. Claiming the invite, marking it used, inserting the member, and removing the temporary claim are one transactional sequence.
- A concurrent registration cannot claim the same `code_hash` because it is the primary key of `invite_claims`.
- If member insertion fails, including a username uniqueness conflict, D1 transaction rollback prevents the invitation from being consumed without a member account.

## Participant withdrawal and deletion

- A member can self-delete only after re-entering the current password and typing the exact confirmation value `DELETE`.
- The sole owner cannot self-delete through the participant endpoint.
- An owner can delete only a `member` account and must re-enter the owner's current password plus `DELETE` confirmation.
- Password-confirmation attempts for deletion are rate-limited independently from normal login attempts.
- Deleting a member cascades through foreign keys to remove that member's sessions, authored messages, reactions, read marker, blocked-member row, dependent invitations, and temporary invite claims.
- References to a deleted participant in `audit_events` use `ON DELETE SET NULL`; the event metadata may remain without the participant identity.
- Application-level deletion must not be described as immediate erasure from D1 Time Travel/disaster-recovery history.

## Privacy-safe append-only audit events

`audit_events` is metadata-only. It may contain:

- event identifier
- event type
- actor user reference
- subject user reference
- timestamp

It must not contain passwords, message bodies, invitation codes, cookies, session tokens, request bodies, or other message content.

Audit protection is layered:

- event types are allowlisted in application code
- D1 rejects unknown event types
- event id/type/timestamp cannot be changed after insertion
- audit rows cannot be deleted through ordinary SQL
- actor/subject references may only remain unchanged or transition from a user id to `NULL`, preserving foreign-key anonymization when a participant is deleted

The audit API is owner-only. General administrative audit writes are best-effort so an audit-table problem does not corrupt an already-successful ordinary operation. Destructive/password security routes that require paired auditability use D1 `batch()` transactions.

## Browser and API controls

- Mutating requests reject cross-origin `Origin` values and cross-site `Sec-Fetch-Site` values.
- JSON mutation routes require `Content-Type: application/json`.
- Request bodies are capped at 16 KiB before downstream route execution.
- Message creation uses an atomic D1 counter limited to 12 writes per 10-second window per authenticated user.
- Static CSP uses `base-uri 'none'` and `form-action 'none'`.
- Static assets use `Cross-Origin-Resource-Policy: same-origin` and remove default cross-origin access.
- API responses are normalized to `Cache-Control: no-store`, restrictive CSP, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, restrictive Permissions Policy, HSTS, frame denial, `nosniff`, no-referrer, and no-index headers.
- Cloudflare Pages `_headers` applies to static assets, so Functions attach their own security headers in code.
- The service worker never caches `/api/`.
- Message/member/invite IDs and API routes/methods are explicitly validated/allowlisted.
- Read markers are validated and additionally clamped by D1 triggers.
- Cursor input is bounded before Base64/JSON decoding.
- Search patterns are bounded by escaped UTF-8 byte length to remain inside D1's `LIKE` pattern limit.
- Security-route logs contain route/method/CF-Ray/error class only and intentionally exclude payloads and credentials.

## Repository and CI controls

- GitHub Actions use read-only repository permissions and full-SHA-pinned actions.
- Checkout uses `persist-credentials: false`.
- CI runs on explicit Ubuntu 24.04 and cancels superseded runs for the same ref.
- `npm run check` recursively syntax-checks application, shared, Function, script, and test JavaScript/MJS, and validates deployment config/migration presence.
- CI regression coverage includes session caps, exact auth routes, transactional invite claims, append-only audit guards, integrity indexes, health gating, request-size limits, security headers, and atomic message throttling.
- CI scans both the current tree and complete Git history for common credential signatures and forbidden secret-bearing filenames.
- Real `.env`, `.dev.vars`, private keys, service-account credentials, and API tokens must never be committed.

## Existing deployment upgrade

For an existing D1 database, apply every migration not already applied:

```text
migrations/0002_security_hardening.sql
migrations/0003_pilot_audit.sql
migrations/0004_runtime_hardening.sql
migrations/0005_session_audit_hardening.sql
```

A deployment with the current pilot schema should return:

```json
{"ok":true,"schema":"pilot-v4"}
```

from `GET /api/health`. The health gate checks required tables, integrity triggers, and lifecycle/session indexes.

## Remaining operational controls

Repository code cannot prove or change all account-level settings. Before an external pilot:

- apply migration 0005 and verify live `pilot-v4` health
- enable MFA on the Cloudflare account
- use least-privilege Cloudflare access
- enable Pages/Workers observability and review logs for CPU/D1/audit failures
- verify actual deployed static/API security headers
- run concurrent invitation registration and session-cap E2E tests
- perform a D1 Time Travel recovery drill on staging
- enable GitHub secret scanning/push protection where available
- protect `main` with required CI checks
- complete the multi-device and withdrawal tests in `PILOT_READINESS.md`

If you discover a vulnerability, do not post family data, credentials, session tokens, message bodies, or invitation codes in a public issue.
