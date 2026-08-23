# Pilot Readiness

This checklist is the release gate for a limited Family S pilot. A source-code CI pass is necessary but does not replace validation in the actual Cloudflare account.

## Current source-level gates

The repository must pass all of the following before a pilot deployment:

- `npm test`
- `npm run check`
- `npm run benchmark:password`
- `npm run security:check`
- `npm run security:history`

The client polling policy is intentionally conservative for a small pilot:

- message refresh: every 10 seconds while the tab is visible
- member refresh: every 60 seconds
- read-marker writes: only when the newest message timestamp advances
- polling stops while the tab is hidden or while search/pinned views are active

The message search validator enforces Cloudflare D1's 50-byte maximum `LIKE` pattern after SQL wildcard escaping and UTF-8 encoding.

Message creation also has an atomic D1 write limiter: at most 12 accepted attempts per authenticated user in a 10-second window. The limiter is implemented with `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`, so concurrent requests cannot all pass a separate count-then-write check.

Pilot security/admin changes are written to `audit_events`. Audit rows intentionally contain only event type, actor/subject references, and timestamp. They never contain passwords, message bodies, invitation codes, or request bodies. If a participant is deleted, foreign-key `ON DELETE SET NULL` removes their user reference from historical audit rows. Audit event types are allowlisted in code and enforced again by D1 triggers.

## Required Cloudflare deployment gates

Do not invite external pilot households until every item below has been checked in the production-like Cloudflare environment.

1. For a new D1 database, apply the current `schema.sql`. For an existing database, apply `migrations/0002_security_hardening.sql`, `migrations/0003_pilot_audit.sql`, and `migrations/0004_runtime_hardening.sql` if they have not already been applied.
2. Configure the D1 binding as `FAMILY_DB`.
3. Configure a long random `FAMILY_SETUP_SECRET` as an encrypted Cloudflare secret.
4. Enable MFA on the Cloudflare account and restrict administrative access to the minimum necessary people.
5. Confirm HTTPS-only access and that the application is served from the intended hostname.
6. Confirm `GET /api/health` returns HTTP 200 and `{"ok":true,"schema":"pilot-v3"}`. HTTP 503 means the D1 binding, a required table, or a required integrity trigger is missing.
7. Confirm the static document response includes `Content-Security-Policy` with `base-uri 'none'` and `form-action 'none'`, `Cross-Origin-Resource-Policy: same-origin`, and `X-Robots-Tag: noindex, nofollow, noarchive`.
8. Confirm API responses include `Cache-Control: no-store`, frame denial, `nosniff`, HSTS, no-referrer, same-origin resource policy, and no-index headers. Pages `_headers` does not apply to Functions responses, so verify the actual API response.
9. Enable Workers/Pages observability and logs before the pilot. For a small pilot, start with 100% head sampling so authentication/CPU/D1 faults are diagnosable, then reduce sampling only if traffic warrants it.
10. Tail Pages Functions logs during the smoke test and confirm there are no 1102 CPU-limit errors, uncaught exceptions, repeated `audit_write_failed` warnings, or D1 overloaded errors.
11. Profile login, registration, password change, self-deletion, and owner-confirmed member deletion with production-like data. The application intentionally keeps PBKDF2-HMAC-SHA256 at 600,000 iterations. Workers Free has a 10 ms CPU limit per HTTP request, so use Workers Paid for the pilot unless measurements in the actual environment demonstrate that the current authentication path is reliable.
12. Confirm the daily request count stays comfortably below the applicable plan limit. The source-level budget test models 3 users active for 4 hours at about 5,046 idle-refresh requests, before user-generated actions.
13. Enable GitHub secret scanning/push protection where available and protect `main` with required CI checks. The repository code cannot enable these account/repository settings by itself.

Cloudflare references:

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers best practices / observability: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- Workers logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Pages Functions routing: https://developers.cloudflare.com/pages/functions/routing/
- Pages headers: https://developers.cloudflare.com/pages/configuration/headers/
- Pages Functions logging: https://developers.cloudflare.com/pages/functions/debugging-and-logging/
- D1 binding and `batch()`: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/

## Multi-device smoke test

Use at least two separate devices/browsers and test both the owner and a member account.

- bootstrap the first owner exactly once
- create an invite and register a member
- reject invite reuse
- send plain text and Japanese text
- send a 2,000-character message and reject 2,001 characters
- reply to a message
- add/remove every allowed reaction
- edit only your own message
- verify member cannot pin messages
- verify owner can pin/unpin and delete a member message
- verify read counts advance across two devices
- search ASCII, Japanese, `%`, `_`, and `\\` values near the D1 byte limit
- verify an over-limit search is rejected cleanly rather than causing a D1 error
- issue more than 12 message POSTs inside one 10-second window and confirm excess requests receive HTTP 429
- repeat that message burst concurrently and confirm parallel requests cannot bypass the limiter
- wait for the 10-second window to reset and confirm normal message sending resumes
- revoke an unused invite and verify it can no longer register
- disable a member and verify all of that member's sessions stop working
- re-enable the member and verify a fresh login is required
- use “logout other devices” and verify the current device remains signed in
- use “logout all devices” and verify every session is rejected and an audit row exists
- change the password and verify old sessions and the old password no longer work
- verify repeated wrong-password attempts against password-change/delete operations eventually return HTTP 429
- verify the owner can view `/api/audit` but a normal member receives HTTP 403
- verify audit output never includes message bodies, passwords, invitation codes, cookies, or request bodies
- leave the chat visible for at least 30 minutes and confirm polling remains stable without request spikes

## Database integrity smoke test

Run these checks on a disposable staging/pilot D1 database, not on a production family space with real data.

- confirm `idx_auth_limits_window_started_at` exists
- confirm `trg_audit_events_type_insert` and `trg_audit_events_type_update` exist
- attempt to insert an audit event with an unknown `event_type` and confirm D1 rejects it
- insert a valid disposable audit row, attempt to change its `event_type`, and confirm D1 rejects the update
- confirm deleting a disposable participant can still null actor/subject references in surviving audit rows; the event-type immutability trigger must not block foreign-key `ON DELETE SET NULL`
- confirm read-clamp triggers still exist and function after migration 0004

`GET /api/health` should remain HTTP 200 / `pilot-v3` after these checks.

## Participant withdrawal and data deletion

Participants can withdraw from the application UI. A member must re-enter the current password and type `DELETE`; `POST /api/auth/delete-account` then deletes the member row. The database cascade removes that member's sessions, authored messages, reactions, read marker, blocked-member record, and invitations they created. Reply links from surviving messages become empty where the referenced message was removed.

The sole owner cannot self-delete through this endpoint. This prevents the pilot family space from being left without an administrator.

When a participant cannot perform self-service deletion, the owner can use the member deletion control. Owner deletion requires the owner's current password plus the explicit `DELETE` confirmation and is limited to member accounts. The operation is rate-limited and audit-recorded.

After any withdrawal/deletion, confirm:

- the deleted member cannot authenticate
- their sessions are absent
- their authored messages and reactions are absent
- the remaining family timeline still renders correctly
- no unrelated family member was affected
- the audit event remains but the deleted participant reference has been nulled where required

Do not promise immediate deletion from Cloudflare's underlying disaster-recovery history. D1 Time Travel may retain a restorable historical database state for the plan's retention window. Pilot consent/privacy text should disclose the operational retention policy accurately.

## Recovery drill

Perform the recovery drill on a disposable pilot/staging D1 database before storing external participant data.

1. Get the current bookmark:

   `npx wrangler d1 time-travel info YOUR_DATABASE`

2. Record a known test message and the current time.
3. Delete or modify that test data intentionally.
4. Restore the database to the recorded pre-change bookmark or timestamp:

   `npx wrangler d1 time-travel restore YOUR_DATABASE --bookmark=YOUR_BOOKMARK`

5. Confirm the test data is restored and that login, timeline, reactions, read markers, invites, blocked-member state, `audit_events`, the audit integrity triggers, and the auth-limit cleanup index still behave correctly.
6. Record the restore result and the `previous_bookmark` so the restore itself can be undone if required.

Time Travel is always enabled for supported D1 production databases. Free-plan history is shorter than Paid-plan history, so confirm the current plan limits before the pilot.

## Incident stop procedure

If a security or data-integrity incident occurs during the pilot:

1. stop issuing invitations and revoke all active invites
2. disable affected member accounts
3. rotate `FAMILY_SETUP_SECRET` if its confidentiality is in doubt
4. revoke affected sessions using logout-all or by disabling the member
5. inspect the privacy-safe audit log and Pages Functions logs without copying message bodies or credentials into tickets
6. check `GET /api/health`; a transition from `pilot-v3`/200 to 503 is a deployment-integrity failure and should stop the pilot
7. use D1 Time Travel if data integrity was damaged
8. pause the pilot until the cause is understood and a regression test has been added

## Pilot go/no-go rule

A family-internal alpha can run after CI passes. External households should only be invited after the Cloudflare deployment gates, multi-device smoke test, database-integrity smoke test, participant-withdrawal procedure, audit-log verification, and recovery drill above have all passed and the results have been recorded.
