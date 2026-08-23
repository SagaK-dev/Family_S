import {
  validateDisplayName,
  validateMessage,
  validatePassword,
  validateReaction,
  validateSearch,
  validateUsername,
} from '../../shared/chat.js';
import { recordAudit, requirePilotUser } from './_security.js';

const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return context.next();
  if (!routeAllowed(method, parts)) return apiError(404, 'Not found.');

  if (method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return apiError(403, 'Cross-site request rejected.');
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return apiError(403, 'Cross-site request rejected.');
  }

  try {
    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'bootstrap' && env?.FAMILY_DB) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const bucket = await sha256Hex(`bootstrap\n${ip}`);
      await consumeBootstrapAttempt(env.FAMILY_DB, bucket);
    }

    if (method === 'GET' && parts[0] === 'messages') {
      validateSearch(url.searchParams.get('q') || '');
      const cursor = url.searchParams.get('cursor');
      if (cursor && cursor.length > 256) throw new Error('Cursor is too long.');
    }

    if (method !== 'GET' && expectsJson(method, parts)) {
      const type = request.headers.get('Content-Type') || '';
      if (!type.toLowerCase().startsWith('application/json')) return apiError(415, 'Content-Type must be application/json.');
      const body = await request.clone().json();
      validatePayload(method, parts, body);
    }
  } catch (error) {
    if (error?.rateLimited) return apiError(429, 'Too many setup attempts. Try again later.');
    if (parts[0] === 'auth' && parts[1] === 'login') return apiError(401, 'Invalid username or password.');
    return apiError(400, error instanceof Error ? error.message : 'Invalid request.');
  }

  const response = await context.next();
  if (response.ok && env?.FAMILY_DB) {
    const descriptor = auditDescriptor(method, parts);
    if (descriptor) {
      try {
        const actor = await requirePilotUser(request, env.FAMILY_DB);
        await recordAudit(env.FAMILY_DB, descriptor.eventType, actor.id, descriptor.subjectUserId);
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'audit_write_failed',
          method,
          path: url.pathname,
          cfRay: request.headers.get('CF-Ray') || null,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }));
      }
    }
  }
  return response;
}

export function routeAllowed(method, parts) {
  if (parts[0] === 'health' && parts.length === 1) return method === 'GET';
  if (parts[0] === 'audit' && parts.length === 1) return method === 'GET';

  if (parts[0] === 'auth' && parts.length === 2) {
    if (parts[1] === 'me') return method === 'GET';
    if (['bootstrap', 'register', 'login', 'logout', 'logout-all', 'logout-others', 'change-password', 'delete-account'].includes(parts[1])) return method === 'POST';
    return false;
  }

  if (parts[0] === 'messages') {
    if (parts.length === 1) return method === 'GET' || method === 'POST';
    if (parts.length === 2 && MESSAGE_ID_RE.test(parts[1])) return method === 'PATCH' || method === 'DELETE';
    if (parts.length === 3 && MESSAGE_ID_RE.test(parts[1]) && parts[2] === 'pin') return method === 'POST';
    return false;
  }

  if (parts[0] === 'members') {
    if (parts.length === 1) return method === 'GET';
    if (parts.length === 3 && MESSAGE_ID_RE.test(parts[1]) && parts[2] === 'disable') return method === 'POST' || method === 'DELETE';
    if (parts.length === 3 && MESSAGE_ID_RE.test(parts[1]) && parts[2] === 'delete') return method === 'POST';
    return false;
  }

  if (parts[0] === 'invites') {
    if (parts.length === 1) return method === 'GET' || method === 'POST';
    if (parts.length === 2 && INVITE_ID_RE.test(parts[1])) return method === 'DELETE';
    return false;
  }

  if (parts.length !== 1) return false;
  if (['reactions', 'read'].includes(parts[0])) return method === 'POST';
  return false;
}

function expectsJson(method, parts) {
  if (method === 'DELETE' || method === 'GET') return false;
  if (parts[0] === 'members' && parts[2] === 'disable') return false;
  return method === 'POST' || method === 'PATCH';
}

function validatePayload(method, parts, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON body must be an object.');

  if (parts[0] === 'auth') {
    if (['logout', 'logout-all', 'logout-others'].includes(parts[1])) return;
    if (parts[1] === 'change-password') {
      const current = String(body.currentPassword ?? '');
      if (current.length < 1 || current.length > 128) throw new Error('Invalid current password.');
      validatePassword(body.newPassword);
      if (current === String(body.newPassword ?? '')) throw new Error('New password must be different.');
      return;
    }
    if (parts[1] === 'delete-account') {
      const current = String(body.currentPassword ?? '');
      if (current.length < 1 || current.length > 128) throw new Error('Invalid current password.');
      if (String(body.confirmation ?? '') !== 'DELETE') throw new Error('Account deletion confirmation is invalid.');
      return;
    }
    validateUsername(body.username);
    if (parts[1] === 'login') {
      const password = String(body.password ?? '');
      if (password.length < 1 || password.length > 128) throw new Error('Invalid credentials.');
      return;
    }
    validateDisplayName(body.displayName);
    validatePassword(body.password);
    if (parts[1] === 'register') {
      const code = String(body.inviteCode ?? '').trim();
      if (code.length < 16 || code.length > 128) throw new Error('Invalid invite code.');
    }
    return;
  }

  if (parts[0] === 'members' && parts[2] === 'delete') {
    const current = String(body.currentPassword ?? '');
    if (current.length < 1 || current.length > 128) throw new Error('Invalid current password.');
    if (String(body.confirmation ?? '') !== 'DELETE') throw new Error('Member deletion confirmation is invalid.');
    return;
  }

  if (parts[0] === 'messages' && parts.length === 1 && method === 'POST') {
    validateMessage(body.body);
    if (body.replyTo != null && !MESSAGE_ID_RE.test(String(body.replyTo))) throw new Error('Invalid reply target.');
    return;
  }

  if (parts[0] === 'messages' && parts.length === 2 && method === 'PATCH') {
    validateMessage(body.body);
    return;
  }

  if (parts[0] === 'messages' && parts[2] === 'pin') {
    if (typeof body.pinned !== 'boolean') throw new Error('Pinned must be a boolean.');
    return;
  }

  if (parts[0] === 'reactions') {
    if (!MESSAGE_ID_RE.test(String(body.messageId || ''))) throw new Error('Invalid message id.');
    validateReaction(body.emoji);
    return;
  }

  if (parts[0] === 'read') {
    const value = Number(body.lastMessageAt);
    if (!Number.isSafeInteger(value) || value < 0 || value > Date.now()) throw new Error('Invalid read marker.');
  }
}

function auditDescriptor(method, parts) {
  if (parts[0] === 'auth' && parts[1] === 'logout-all' && method === 'POST') return { eventType: 'sessions_revoked_all', subjectUserId: null };
  if (parts[0] === 'members' && parts[2] === 'disable') {
    return { eventType: method === 'POST' ? 'member_disabled' : 'member_enabled', subjectUserId: parts[1] };
  }
  if (parts[0] === 'invites' && parts.length === 1 && method === 'POST') return { eventType: 'invite_created', subjectUserId: null };
  if (parts[0] === 'invites' && parts.length === 2 && method === 'DELETE') return { eventType: 'invite_revoked', subjectUserId: null };
  if (parts[0] === 'messages' && parts.length === 2 && method === 'DELETE') return { eventType: 'message_deleted', subjectUserId: null };
  if (parts[0] === 'messages' && parts.length === 3 && parts[2] === 'pin' && method === 'POST') return { eventType: 'message_pin_changed', subjectUserId: null };
  return null;
}

async function consumeBootstrapAttempt(db, bucket) {
  const now = Date.now();
  const row = await db.prepare(`
    INSERT INTO auth_limits (bucket_hash, attempts, window_started_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_hash) DO UPDATE SET
      attempts = CASE WHEN auth_limits.window_started_at + ? <= ? THEN 1 ELSE auth_limits.attempts + 1 END,
      window_started_at = CASE WHEN auth_limits.window_started_at + ? <= ? THEN ? ELSE auth_limits.window_started_at END
    RETURNING attempts`)
    .bind(bucket, now, AUTH_WINDOW_MS, now, AUTH_WINDOW_MS, now, now).first();
  if (Number(row?.attempts || 0) > 10) {
    const error = new Error('Rate limited');
    error.rateLimited = true;
    throw error;
  }
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function apiError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
