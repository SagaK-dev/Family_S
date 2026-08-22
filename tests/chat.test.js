import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReactionSummary,
  decodeCursor,
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

test('search validation enforces a bounded query', () => {
  assert.equal(validateSearch('  dinner  '), 'dinner');
  assert.throws(() => validateSearch('x'.repeat(101)));
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
