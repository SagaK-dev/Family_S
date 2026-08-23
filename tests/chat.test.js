import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReactionSummary,
  buildSearchPattern,
  decodeCursor,
  D1_LIKE_PATTERN_MAX_BYTES,
  encodeCursor,
  normalizeUsername,
  runTimelinePipeline,
  validateDisplayName,
  validateMessage,
  validatePassword,
  validateReaction,
  validateSearch,
  validateUsername,
} from '../shared/chat.js';
import {
  MEMBER_POLL_EVERY,
  MESSAGE_POLL_MS,
  estimateIdleRequests,
  shouldSendReadMarker,
} from '../shared/pilot.js';
import { routeAllowed } from '../functions/api/_middleware.js';
import { PBKDF2_ITERATIONS, SESSION_COOKIE, parsePasswordHash } from '../functions/api/[[path]].js';

test('normalizes and validates usernames', () => {
  assert.equal(normalizeUsername('  Family_1 '), 'family_1');
  assert.equal(validateUsername('Family_1'), 'family_1');
  assert.throws(() => validateUsername('a'));
  assert.throws(() => validateUsername('bad name'));
});

test('validates display names and passwords', () => {
  assert.equal(validateDisplayName('  お母さん  '), 'お母さん');
  assert.equal(validatePassword('long-password-123'), 'long-password-123');
  assert.throws(() => validateDisplayName(''));
  assert.throws(() => validatePassword('short'));
});

test('message validation trims content without allowing empty messages', () => {
  assert.equal(validateMessage('  hello family  '), 'hello family');
  assert.throws(() => validateMessage('   '));
  assert.throws(() => validateMessage('x'.repeat(2001)));
});

test('search validation respects D1 LIKE pattern byte limit', () => {
  assert.equal(validateSearch('  dinner  '), 'dinner');
  assert.equal(validateSearch('x'.repeat(48)), 'x'.repeat(48));
  assert.throws(() => validateSearch('x'.repeat(49)));
  assert.equal(validateSearch('家'.repeat(16)), '家'.repeat(16));
  assert.throws(() => validateSearch('家'.repeat(17)));
  assert.equal(new TextEncoder().encode(buildSearchPattern('%'.repeat(24))).byteLength, D1_LIKE_PATTERN_MAX_BYTES);
  assert.throws(() => validateSearch('%'.repeat(25)));
});

test('reaction allowlist rejects arbitrary emoji or text', () => {
  assert.equal(validateReaction('❤️'), '❤️');
  assert.throws(() => validateReaction('🔥'));
  assert.throws(() => validateReaction('<script>'));
});

test('cursor round trips timestamp and message id', () => {
  const encoded = encodeCursor({ createdAt: 1720000000000, id: 'abc-123' });
  assert.deepEqual(decodeCursor(encoded), { createdAt: 1720000000000, id: 'abc-123' });
  assert.equal(decodeCursor('not valid!'), null);
  assert.equal(decodeCursor('A'.repeat(257)), null);
});

test('timeline pipeline removes duplicates and hidden rows, then orders chronologically', () => {
  const rows = [
    { id: 'b', userId: 'u2', createdAt: 20, body: 'second' },
    { id: 'a', userId: 'u1', createdAt: 10, body: 'first' },
    { id: 'a', userId: 'u1', createdAt: 10, body: 'duplicate' },
    { id: 'c', userId: 'u1', createdAt: 30, body: 'hidden', hidden: true },
  ];
  const result = runTimelinePipeline(rows, { currentUserId: 'u1', limit: 50 });
  assert.deepEqual(result.map(item => item.id), ['a', 'b']);
  assert.equal(result[0].isMine, true);
  assert.equal(result[1].isMine, false);
});

test('timeline pipeline clamps page size', () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({ id: String(index), userId: 'u', createdAt: index }));
  assert.equal(runTimelinePipeline(rows, { limit: 999 }).length, 100);
  assert.equal(runTimelinePipeline(rows, { limit: 3 }).length, 3);
});

test('reaction summary counts reactions and marks current-user state', () => {
  const summary = buildReactionSummary([
    { message_id: 'm1', user_id: 'u1', emoji: '👍' },
    { message_id: 'm1', user_id: 'u2', emoji: '👍' },
    { message_id: 'm1', user_id: 'u2', emoji: '❤️' },
    { message_id: 'm1', user_id: 'u3', emoji: '🔥' },
  ], 'u1');
  const thumbs = summary.m1.find(item => item.emoji === '👍');
  assert.deepEqual(thumbs, { emoji: '👍', count: 2, reacted: true });
  assert.equal(summary.m1.some(item => item.emoji === '🔥'), false);
});

test('API middleware allows only explicit message routes', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(routeAllowed('GET', ['messages']), true);
  assert.equal(routeAllowed('POST', ['messages']), true);
  assert.equal(routeAllowed('PATCH', ['messages', id]), true);
  assert.equal(routeAllowed('POST', ['messages', id, 'pin']), true);
  assert.equal(routeAllowed('PATCH', ['messages', id, 'unexpected']), false);
  assert.equal(routeAllowed('DELETE', ['messages', 'not-an-id']), false);
});

test('deployment health route is read-only and explicit', () => {
  assert.equal(routeAllowed('GET', ['health']), true);
  assert.equal(routeAllowed('POST', ['health']), false);
  assert.equal(routeAllowed('GET', ['health', 'details']), false);
});

test('API middleware exposes hardened auth session controls only by POST', () => {
  for (const action of ['login', 'logout', 'logout-all', 'logout-others', 'change-password']) {
    assert.equal(routeAllowed('POST', ['auth', action]), true);
    assert.equal(routeAllowed('GET', ['auth', action]), false);
  }
  assert.equal(routeAllowed('GET', ['auth', 'me']), true);
  assert.equal(routeAllowed('POST', ['admin']), false);
});

test('API middleware restricts member disable and invitation revocation routes', () => {
  const memberId = '123e4567-e89b-42d3-a456-426614174000';
  const inviteId = 'A'.repeat(43);
  assert.equal(routeAllowed('GET', ['members']), true);
  assert.equal(routeAllowed('POST', ['members', memberId, 'disable']), true);
  assert.equal(routeAllowed('DELETE', ['members', memberId, 'disable']), true);
  assert.equal(routeAllowed('POST', ['members', memberId, 'other']), false);
  assert.equal(routeAllowed('GET', ['invites']), true);
  assert.equal(routeAllowed('POST', ['invites']), true);
  assert.equal(routeAllowed('DELETE', ['invites', inviteId]), true);
  assert.equal(routeAllowed('DELETE', ['invites', 'short']), false);
});

test('password hash parser supports legacy upgrade and current 600k format', () => {
  const legacy = parsePasswordHash('A'.repeat(43));
  assert.equal(legacy.iterations, 240_000);
  assert.equal(legacy.needsUpgrade, true);
  const current = parsePasswordHash(`pbkdf2-sha256$${PBKDF2_ITERATIONS}$${'B'.repeat(43)}`);
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  assert.equal(current.iterations, 600_000);
  assert.equal(current.needsUpgrade, false);
  assert.throws(() => parsePasswordHash('pbkdf2-sha256$99999999$' + 'C'.repeat(43)));
});

test('session cookie uses the host-only security prefix', () => {
  assert.equal(SESSION_COOKIE, '__Host-family_s_session');
});

test('pilot polling budget is substantially lower than the previous 2.5 second design', () => {
  assert.equal(MESSAGE_POLL_MS, 10_000);
  assert.equal(MEMBER_POLL_EVERY, 6);
  const current = estimateIdleRequests({ users: 3, hours: 4 });
  const previous = 3 * (2 + Math.floor((4 * 60 * 60 * 1000) / 2_500) * 2);
  assert.equal(current, 5046);
  assert.ok(current < previous / 6);
});

test('read markers are sent only when the newest message advances', () => {
  assert.equal(shouldSendReadMarker(0, 100), true);
  assert.equal(shouldSendReadMarker(100, 100), false);
  assert.equal(shouldSendReadMarker(101, 100), false);
  assert.equal(shouldSendReadMarker(100, 101), true);
});