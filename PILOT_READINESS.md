# Pilot Readiness

This checklist is the release gate for a limited Family S pilot. Source-code CI is necessary but does not replace validation in the actual Cloudflare account.

## Source-level gates

The repository must pass:

- `npm test`
- `npm run check`
- `npm run benchmark:password`
- `npm run security:check`
- `npm run security:history`

Current source-level controls include:

- message refresh every 10 seconds while visible
- member refresh every 60 seconds
- read-marker writes only when the newest message advances
- D1-safe 50-byte `LIKE` search bound after escaping/UTF-8 encoding
- atomic message limiter: 12 attempts/user/10 seconds
- maximum 8 active sessions/user after session issuance
- exact Pages Function routes for all core authentication endpoints
- concurrency-safe invitation registration using unique `invite_claims` inside a D1 batch
- metadata-only, append-only audit events with participant-reference anonymization allowed

## Required Cloudflare deployment gates

Do not invite external pilot households until every item is checked in a production-like environment.

1. New D1: apply current `schema.sql`. Existing D1: apply every missing migration in order through `migrations/0005_session_audit_hardening.sql`.
2. Configure the D1 binding as `FAMILY_DB`.
3. Configure a long random `FAMILY_SETUP_SECRET` as an encrypted Cloudflare secret.
4. Enable MFA and restrict Cloudflare administrative access to the minimum necessary people.
5. Confirm HTTPS-only access on the intended hostname.
6. Confirm `GET /api/health` returns HTTP 200 and `{"ok":true,"schema":"pilot-v4"}`. HTTP 503 means a required binding/table/trigger/index is missing.
7. Confirm static responses include restrictive CSP (`base-uri 'none'`, `form-action 'none'`), same-origin resource policy, and no-index headers.
8. Confirm API responses include `Cache-Control: no-store`, restrictive CSP, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, restrictive Permissions Policy, HSTS, frame denial, `nosniff`, no-referrer, and no-index headers.
9. Enable Pages/Workers observability before the pilot. Start with sufficiently high sampling for a small pilot so authentication/CPU/D1 faults can be diagnosed.
10. During smoke testing, confirm there are no Workers CPU-limit errors, uncaught exceptions, repeated `audit_write_failed` warnings, or D1 overload errors.
11. Profile login, registration, password change, self-deletion, and owner-confirmed deletion with production-like data. PBKDF2 remains 600,000 iterations; do not assume the Workers Free CPU allowance is sufficient.
12. Confirm daily request volume remains comfortably below the applicable plan limit. The source model estimates about 5,046 idle refresh requests for 3 users over 4 visible hours.
13. Enable GitHub secret scanning/push protection where available and protect `main` with required CI checks.

Cloudflare references:

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers best practices: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- Workers logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Pages Functions routing: https://developers.cloudflare.com/pages/functions/routing/
- Pages headers: https://developers.cloudflare.com/pages/configuration/headers/
- D1 database / `batch()`: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/

## Multi-device smoke test

Use at least two separate devices/browsers and both owner/member accounts.

- bootstrap the first owner exactly once
- create an invite and register a member
- reject invite reuse
- attempt two registrations against the same invite concurrently; exactly one must succeed
- trigger a username conflict during registration and verify the invite is not consumed by the failed transaction
- login repeatedly from more than 8 browser contexts and verify older sessions are pruned so at most 8 remain active
- send plain text, Japanese text, and a 2,000-character message; reject 2,001 characters
- reply, react/unreact, edit only own messages
- verify member cannot pin and owner can pin/unpin
- verify read counts across devices
- test ASCII/Japanese/`%`/`_`/`\\` searches near the D1 limit and reject over-limit search cleanly
- issue >12 message POSTs in one 10-second window and confirm excess requests return 429
- repeat the burst concurrently and confirm parallel requests cannot bypass the limiter
- revoke an unused invite and verify registration fails
- disable a member and verify every session stops working
- re-enable the member and require a fresh login
- verify logout-other-devices preserves current session
- verify logout-all revokes every session and creates an audit event
- change the password and verify old sessions/password fail
- verify repeated wrong current-password attempts eventually return 429
- verify owner can view `/api/audit` and member receives 403
- verify audit output contains no messages/passwords/invite codes/cookies/request bodies
- keep the chat visible for at least 30 minutes and confirm stable polling without spikes

## Database integrity smoke test

Run on disposable staging/pilot D1 only.

Confirm the following objects exist after migration 0005:

- table `invite_claims`
- index `idx_sessions_user_created`
- index `idx_invites_created_by`
- index `idx_messages_user`
- index `idx_messages_pinned_by`
- index `idx_reactions_user`
- index `idx_audit_events_subject`
- triggers `trg_audit_events_type_insert`, `trg_audit_events_type_update`
- triggers `trg_audit_events_guard_update`, `trg_audit_events_guard_delete`
- read-clamp triggers

Then verify:

- unknown audit event type insertion is rejected
- changing audit event id/type/timestamp is rejected
- changing actor/subject to a different non-null user is rejected
- deleting an audit row is rejected
- deleting a disposable participant can still change their surviving audit references from user id to `NULL`
- concurrent invitation claims cannot both succeed
- a failed member insert rolls back invitation consumption
- `/api/health` remains HTTP 200 / `pilot-v4`

## Participant withdrawal and data deletion

A member withdraws by re-entering the current password and typing `DELETE`. The owner can perform an owner-confirmed member deletion when self-service is unavailable.

After deletion confirm:

- the account cannot authenticate
- all sessions are gone
- authored messages/reactions/read marker are gone
- dependent invites and temporary invite claims are gone
- the remaining timeline renders correctly
- unrelated users are unaffected
- surviving audit event metadata remains but the deleted user's actor/subject references are `NULL` where applicable

Do not promise immediate deletion from D1 disaster-recovery history. Time Travel may retain a restorable historical state for the plan's retention window.

## Recovery drill

Perform on disposable staging D1 before external participant data is stored.

1. Record a Time Travel bookmark.
2. Add known disposable test data.
3. Intentionally delete/modify it.
4. Restore to the pre-change bookmark/timestamp.
5. Confirm login, sessions, timeline, reactions, reads, invites, `invite_claims`, blocked-member state, audit events/triggers, and required indexes behave correctly after restore.
6. Record the restore result and previous bookmark so the restore can be reversed if necessary.

## Incident stop procedure

If a security/data-integrity incident occurs:

1. stop issuing invitations and revoke active invites
2. disable affected member accounts
3. rotate `FAMILY_SETUP_SECRET` if confidentiality is in doubt
4. revoke affected sessions
5. inspect metadata-only audit events and Pages Functions logs without copying private message content or credentials into tickets
6. check `/api/health`; anything other than HTTP 200 / `pilot-v4` is a deployment-integrity stop condition
7. use D1 Time Travel if data integrity was damaged
8. pause the pilot until the cause is understood and a regression test is added

## Go / no-go

A family-internal alpha can run after CI passes. External households should be invited only after the Cloudflare deployment gates, multi-device smoke test, database-integrity test, withdrawal procedure, audit verification, and recovery drill above have passed and results have been recorded.
