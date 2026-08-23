import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MAX_ACTIVE_SESSIONS,
  createPilotSession,
  pilotJson,
  publicPilotUser,
  timingSafeTextEqual,
} from '../functions/api/_security.js';

test('session creation is transactionally capped per user', async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        bind(...args) { return { sql, args }; },
      };
    },
    async batch(items) {
      statements.push(...items);
      return items.map(() => ({ meta: { changes: 1 } }));
    },
  };

  const cookie = await createPilotSession(db, 'user-1');
  assert.equal(MAX_ACTIVE_SESSIONS, 8);
  assert.match(cookie, /^__Host-family_s_session=v2\.[A-Za-z0-9_-]{43};/);
  assert.equal(statements.length, 3);
  assert.match(statements[0].sql, /DELETE FROM sessions WHERE expires_at/);
  assert.match(statements[1].sql, /ORDER BY created_at DESC, token_hash DESC/);
  assert.equal(statements[1].args[2], MAX_ACTIVE_SESSIONS - 1);
  assert.match(statements[2].sql, /INSERT INTO sessions/);
});

test('public user projection never exposes credential columns', () => {
  const projected = publicPilotUser({
    id: 'u1', username: 'family', display_name: 'Family', role: 'member', created_at: 1,
    password_hash: 'secret-hash', password_salt: 'secret-salt',
  });
  assert.deepEqual(projected, { id: 'u1', username: 'family', displayName: 'Family', role: 'member', createdAt: 1 });
  assert.equal('password_hash' in projected, false);
  assert.equal('password_salt' in projected, false);
});

test('security helper compares setup secrets without direct text equality', async () => {
  assert.equal(await timingSafeTextEqual('same-secret', 'same-secret'), true);
  assert.equal(await timingSafeTextEqual('same-secret', 'different-secret'), false);
});

test('API helper sends isolation and feature-restriction headers', () => {
  const response = pilotJson({ ok: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(response.headers.get('permissions-policy') || '', /camera=\(\)/);
  assert.match(response.headers.get('content-security-policy') || '', /form-action 'none'/);
});

test('registration is an exact route and consumes invites transactionally', () => {
  const source = fs.readFileSync(new URL('../functions/api/auth/register.js', import.meta.url), 'utf8');
  assert.match(source, /FAMILY_DB\.batch/);
  assert.match(source, /UPDATE invites SET used_at/);
  assert.match(source, /INSERT INTO users/);
  assert.match(source, /WHERE EXISTS/);
  assert.doesNotMatch(source, /SELECT \* FROM invites/);
});

test('all core authentication endpoints have exact Pages Function routes', () => {
  for (const name of ['me', 'bootstrap', 'register', 'login', 'logout', 'logout-others', 'logout-all', 'change-password', 'delete-account']) {
    assert.equal(fs.existsSync(new URL(`../functions/api/auth/${name}.js`, import.meta.url)), true, `${name}.js missing`);
  }
});

test('audit history is append-only except foreign-key anonymization', () => {
  const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = fs.readFileSync(new URL('../migrations/0005_session_audit_hardening.sql', import.meta.url), 'utf8');
  for (const sql of [schema, migration]) {
    assert.match(sql, /trg_audit_events_guard_update/);
    assert.match(sql, /trg_audit_events_guard_delete/);
    assert.match(sql, /audit event is append-only/);
    assert.match(sql, /audit event deletion is not allowed/);
    assert.match(sql, /OLD\.actor_user_id IS NOT NULL AND NEW\.actor_user_id IS NULL/);
    assert.match(sql, /OLD\.subject_user_id IS NOT NULL AND NEW\.subject_user_id IS NULL/);
  }
});

test('lifecycle foreign-key paths and session pruning are indexed', () => {
  const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  for (const index of [
    'idx_sessions_user_created',
    'idx_invites_created_by',
    'idx_messages_user',
    'idx_messages_pinned_by',
    'idx_reactions_user',
    'idx_audit_events_subject',
  ]) {
    assert.match(schema, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`));
  }
});

test('health gate requires v4 audit/session integrity objects', () => {
  const source = fs.readFileSync(new URL('../functions/api/health.js', import.meta.url), 'utf8');
  assert.match(source, /pilot-v4/);
  assert.match(source, /trg_audit_events_guard_update/);
  assert.match(source, /trg_audit_events_guard_delete/);
  assert.match(source, /idx_sessions_user_created/);
  assert.match(source, /idx_audit_events_subject/);
});
