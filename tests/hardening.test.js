import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { AUDIT_EVENT_TYPES, recordAudit } from '../functions/api/_security.js';
import {
  MESSAGE_WRITE_LIMIT,
  MESSAGE_WRITE_WINDOW_MS,
  secureApiResponse,
} from '../functions/api/_middleware.js';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('audit event types are explicit, unique, and reject unknown values before D1 access', async () => {
  const expected = [
    'password_changed',
    'account_deleted',
    'member_deleted',
    'sessions_revoked_all',
    'member_disabled',
    'member_enabled',
    'invite_created',
    'invite_revoked',
    'message_deleted',
    'message_pin_changed',
  ];
  assert.deepEqual(AUDIT_EVENT_TYPES, expected);
  assert.equal(new Set(AUDIT_EVENT_TYPES).size, AUDIT_EVENT_TYPES.length);

  let touched = false;
  const db = {
    prepare() {
      touched = true;
      throw new Error('D1 should not be touched for an unsupported audit type');
    },
  };
  await assert.rejects(recordAudit(db, 'unexpected_event'), /Unsupported audit event type/);
  assert.equal(touched, false);
});

test('schema and migration enforce audit type immutability and indexed rate-limit cleanup', () => {
  const schema = read('../schema.sql');
  const migration = read('../migrations/0004_runtime_hardening.sql');

  for (const sql of [schema, migration]) {
    assert.match(sql, /idx_auth_limits_window_started_at/);
    assert.match(sql, /trg_audit_events_type_insert/);
    assert.match(sql, /NEW\.event_type NOT IN/);
    assert.match(sql, /trg_audit_events_type_update/);
    assert.match(sql, /audit event type is immutable/);
    for (const eventType of AUDIT_EVENT_TYPES) assert.match(sql, new RegExp(`'${eventType}'`));
  }
});

test('health gate requires integrity triggers and advertises pilot-v3', () => {
  const source = read('../functions/api/health.js');
  assert.match(source, /pilot-v3/);
  for (const trigger of [
    'trg_reads_clamp_insert',
    'trg_reads_clamp_update',
    'trg_audit_events_type_insert',
    'trg_audit_events_type_update',
  ]) {
    assert.match(source, new RegExp(trigger));
  }
});

test('static policy blocks fallback form submission and cross-origin reuse', () => {
  const headers = read('../_headers');
  assert.match(headers, /! Access-Control-Allow-Origin/);
  assert.match(headers, /Cross-Origin-Resource-Policy: same-origin/);
  assert.match(headers, /X-Robots-Tag: noindex, nofollow, noarchive/);
  assert.match(headers, /base-uri 'none'/);
  assert.match(headers, /form-action 'none'/);
});

test('API response hardening preserves cookies while enforcing no-store isolation headers', () => {
  const original = new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': '__Host-family_s_session=v2.test; Path=/; Secure; HttpOnly',
    },
  });
  const response = secureApiResponse(original);

  assert.equal(response.status, 201);
  assert.match(response.headers.get('set-cookie') || '', /__Host-family_s_session=/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(response.headers.get('content-security-policy') || '', /form-action 'none'/);
});

test('message write throttling uses a short bounded atomic window', () => {
  assert.equal(MESSAGE_WRITE_LIMIT, 12);
  assert.equal(MESSAGE_WRITE_WINDOW_MS, 10_000);
  const source = read('../functions/api/_middleware.js');
  assert.match(source, /message\\n\$\{userId\}/);
  assert.match(source, /INSERT INTO auth_limits/);
  assert.match(source, /ON CONFLICT\(bucket_hash\) DO UPDATE/);
  assert.match(source, /RETURNING attempts/);
  assert.match(source, /messageRateLimited/);
});
