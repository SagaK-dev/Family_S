# Security

Family S is a private family chat application, but it is not end-to-end encrypted. Message bodies are stored in Cloudflare D1 so the server can provide search, reply context, and timeline queries.

## Authentication and sessions

- New password hashes use PBKDF2-HMAC-SHA256 with 600,000 iterations, a random 16-byte salt, and a 256-bit output.
- Existing 240,000-iteration hashes remain readable and are upgraded after the next successful login.
- Login verification performs a fixed-cost dummy PBKDF2 operation for unknown users to reduce username-enumeration timing differences for current-format accounts.
- Login throttling uses atomic D1 UPSERT operations for both an IP-wide bucket and an IP+username bucket.
- Session tokens contain 256 random bits, are stored only as SHA-256 hashes in D1, and use the `__Host-family_s_session` cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`.
- Only `v2.` session tokens are accepted. Sessions issued before this hardening release are therefore rejected and users must sign in again after deployment.
- Users can invalidate every other session, invalidate every session, or change their password. Password changes revoke all existing sessions and issue a fresh current session.
- The family owner can disable a member account. Disabling also deletes that member's sessions; re-enabling does not create a session.

## Invitations

- Invitation codes use 192 random bits and only their SHA-256 hashes are stored in D1.
- Invitations are single use and expire after one hour.
- The owner can list active invitations and revoke them before use.

## Browser and API controls

- Mutating requests reject cross-origin `Origin` values and cross-site `Sec-Fetch-Site` values.
- CSP, frame denial, referrer restrictions, `nosniff`, HSTS, and a restrictive Permissions Policy are configured.
- API responses are `Cache-Control: no-store` and the service worker never caches `/api/`.
- Message IDs and invite IDs are validated and API routes/methods are explicitly allowlisted.
- Read markers are validated and additionally clamped by D1 triggers.
- Cursor input is length-bounded before Base64/JSON decoding.

## Repository and CI controls

- GitHub Actions are pinned to full commit SHAs.
- Checkout uses `persist-credentials: false` and read-only repository permissions.
- CI scans both the current tree and complete Git history for common credential signatures and forbidden secret-bearing filenames.
- Real `.env`, `.dev.vars`, private keys, service-account credentials, and API tokens must never be committed.

## Existing deployment upgrade

Before deploying this hardening release to an existing D1 database, apply:

```sql
migrations/0002_security_hardening.sql
```

Alternatively, re-running the idempotent `schema.sql` creates the same new table/index.

After deployment, all users must sign in again because pre-v2 session tokens are intentionally rejected.

## Remaining operational controls

Repository code cannot enable account-level Cloudflare or GitHub settings by itself. For production, enable MFA on the Cloudflare account, use least-privilege Cloudflare access, enable GitHub secret scanning/push protection where available, and protect the `main` branch with required CI checks.

If you discover a vulnerability, do not post family data, credentials, session tokens, or invitation codes in a public issue.