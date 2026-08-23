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

## Required Cloudflare deployment gates

Do not invite external pilot households until every item below has been checked in the production-like Cloudflare environment.

1. Apply `schema.sql` for a new database, or `migrations/0002_security_hardening.sql` for an existing database.
2. Configure the D1 binding as `FAMILY_DB`.
3. Configure a long random `FAMILY_SETUP_SECRET` as an encrypted Cloudflare secret.
4. Enable MFA on the Cloudflare account and restrict administrative access to the minimum necessary people.
5. Confirm HTTPS-only access and that the application is served from the intended hostname.
6. Confirm `GET /api/health` returns HTTP 200 and `{"ok":true,"schema":"pilot-v1"}`.
7. Tail Pages Functions logs during the smoke test and confirm there are no 1102 CPU-limit errors, uncaught exceptions, or D1 overloaded errors.
8. Profile login, registration, and password change with production-like data. The application intentionally keeps PBKDF2-HMAC-SHA256 at 600,000 iterations. Workers Free has a 10 ms CPU limit per HTTP request, so use Workers Paid for the pilot unless measurements in the actual environment demonstrate that the current authentication path is reliable.
9. Confirm the daily request count stays comfortably below the applicable plan limit. The source-level budget test models 3 users active for 4 hours at about 5,046 idle-refresh requests, before user-generated actions.
10. Enable GitHub secret scanning/push protection where available and protect `main` with required CI checks. The repository code cannot enable these account/repository settings by itself.

Cloudflare references:

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Pages Functions logging: https://developers.cloudflare.com/pages/functions/debugging-and-logging/
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
- revoke an unused invite and verify it can no longer register
- disable a member and verify all of that member's sessions stop working
- re-enable the member and verify a fresh login is required
- use “logout other devices” and verify the current device remains signed in
- use “logout all devices” and verify every session is rejected
- change the password and verify old sessions and the old password no longer work
- leave the chat visible for at least 30 minutes and confirm polling remains stable without request spikes

## Participant withdrawal and data deletion

For a limited pilot, withdrawal is an operator-controlled procedure. Record the participant's stable D1 user ID when onboarding so deletion does not depend only on a display name.

Before deletion, explain the effect to the participant: deleting a member row also removes that member's authored messages, sessions, reactions, read marker, and blocked-member entry through the current foreign-key cascade rules. Reply links from surviving messages become empty where the referenced message was removed.

Use a staging copy first and verify the target is a `member`, never the sole `owner`:

```sql
SELECT id, username, role FROM users WHERE id = 'PARTICIPANT_UUID';
```

After confirming the ID and role, delete the participant:

```sql
DELETE FROM users WHERE id = 'PARTICIPANT_UUID' AND role = 'member';
```

Then confirm:

- the deleted member cannot authenticate
- their sessions are absent
- their authored messages and reactions are absent
- the remaining family timeline still renders correctly
- no unrelated family member was affected

Do not promise immediate deletion from Cloudflare's underlying disaster-recovery history. D1 Time Travel may retain a restorable historical database state for the plan's retention window. Pilot consent/privacy text should disclose the operational retention policy accurately.

## Recovery drill

Perform the recovery drill on a disposable pilot/staging D1 database before storing external participant data.

1. Get the current bookmark:

   `npx wrangler d1 time-travel info YOUR_DATABASE`

2. Record a known test message and the current time.
3. Delete or modify that test data intentionally.
4. Restore the database to the recorded pre-change bookmark or timestamp:

   `npx wrangler d1 time-travel restore YOUR_DATABASE --bookmark=YOUR_BOOKMARK`

5. Confirm the test data is restored and that login, timeline, reactions, read markers, invites, and blocked-member state still behave correctly.
6. Record the restore result and the `previous_bookmark` so the restore itself can be undone if required.

Time Travel is always enabled for supported D1 production databases. Free-plan history is shorter than Paid-plan history, so confirm the current plan limits before the pilot.

## Incident stop procedure

If a security or data-integrity incident occurs during the pilot:

1. stop issuing invitations and revoke all active invites
2. disable affected member accounts
3. rotate `FAMILY_SETUP_SECRET` if its confidentiality is in doubt
4. revoke affected sessions using logout-all or by disabling the member
5. inspect Pages Functions logs without copying message bodies or credentials into tickets
6. use D1 Time Travel if data integrity was damaged
7. pause the pilot until the cause is understood and a regression test has been added

## Pilot go/no-go rule

A family-internal alpha can run after CI passes. External households should only be invited after the Cloudflare deployment gates, multi-device smoke test, participant-withdrawal procedure, and recovery drill above have all passed and the results have been recorded.