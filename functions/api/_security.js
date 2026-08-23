import { PBKDF2_ITERATIONS, SESSION_COOKIE, parsePasswordHash } from './[[path]].js';

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_STALE_MS = 24 * 60 * 60 * 1000;
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const DUMMY_SALT = new Uint8Array([73, 28, 244, 11, 91, 167, 35, 214, 64, 202, 17, 121, 8, 99, 188, 51]);
const DUMMY_DIGEST = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const MAX_ACTIVE_SESSIONS = 8;

export const AUDIT_EVENT_TYPES = Object.freeze([
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
]);
const AUDIT_EVENT_TYPE_SET = new Set(AUDIT_EVENT_TYPES);

export async function optionalPilotUser(request, db) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^v2\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const user = await db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN blocked_users b ON b.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND b.user_id IS NULL`)
    .bind(await hashOpaqueValue(token), Date.now()).first();
  return user || null;
}

export async function requirePilotUser(request, db) {
  const user = await optionalPilotUser(request, db);
  if (!user) throw new PilotHttpError(401, 'Authentication required.');
  return user;
}

export function readPilotSessionToken(request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^v2\.[A-Za-z0-9_-]{43}$/.test(token)) throw new PilotHttpError(401, 'Authentication required.');
  return token;
}

export function publicPilotUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
  };
}

export async function verifyPilotPassword(password, user) {
  const value = String(password || '');
  if (value.length < 1 || value.length > 128) return false;
  try {
    const parsed = parsePasswordHash(user.password_hash);
    const salt = base64UrlToBytes(user.password_salt);
    const digest = await derivePassword(value, salt, parsed.iterations);
    return constantTimeAscii(digest, parsed.digest);
  } catch {
    return false;
  }
}

export async function verifyPilotLoginPassword(password, user) {
  const value = String(password || '');
  if (value.length < 1 || value.length > 128) return { valid: false, needsUpgrade: false };
  if (!user) {
    const actual = await derivePassword(value, DUMMY_SALT, PBKDF2_ITERATIONS);
    constantTimeAscii(actual, DUMMY_DIGEST);
    return { valid: false, needsUpgrade: false };
  }
  try {
    const parsed = parsePasswordHash(user.password_hash);
    const salt = base64UrlToBytes(user.password_salt);
    const digest = await derivePassword(value, salt, parsed.iterations);
    return { valid: constantTimeAscii(digest, parsed.digest), needsUpgrade: parsed.needsUpgrade };
  } catch {
    return { valid: false, needsUpgrade: false };
  }
}

export async function hashPilotPassword(password) {
  const value = String(password || '');
  if (value.length < 10 || value.length > 128) throw new PilotHttpError(400, 'Password must be 10–128 characters.');
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToBase64Url(saltBytes);
  const digest = await derivePassword(value, saltBytes, PBKDF2_ITERATIONS);
  return { salt, hash: `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${digest}` };
}

export async function consumeLoginAttempts(request, db, username) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipBucket = await hashOpaqueValue(`ip\n${ip}`);
  const credentialBucket = await hashOpaqueValue(`ip-user\n${ip}\n${username}`);
  await consumeAttemptCounter(db, ipBucket, 60, 'Too many login attempts. Try again later.');
  await consumeAttemptCounter(db, credentialBucket, 10, 'Too many login attempts. Try again later.');
  return { credentialBucket };
}

export async function clearLoginAttempt(db, credentialBucket) {
  await db.prepare('DELETE FROM auth_limits WHERE bucket_hash = ?').bind(credentialBucket).run();
}

export async function consumeSensitiveAttempt(request, db, userId, action, limit = 8) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = await hashOpaqueValue(`sensitive\n${action}\n${ip}\n${userId}`);
  await consumeAttemptCounter(db, bucket, limit, 'Too many verification attempts. Try again later.');
  return bucket;
}

export async function clearSensitiveAttempt(db, bucket) {
  await db.prepare('DELETE FROM auth_limits WHERE bucket_hash = ?').bind(bucket).run();
}

async function consumeAttemptCounter(db, bucket, limit, message) {
  const now = Date.now();
  const row = await db.prepare(`
    INSERT INTO auth_limits (bucket_hash, attempts, window_started_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_hash) DO UPDATE SET
      attempts = CASE WHEN auth_limits.window_started_at + ? <= ? THEN 1 ELSE auth_limits.attempts + 1 END,
      window_started_at = CASE WHEN auth_limits.window_started_at + ? <= ? THEN ? ELSE auth_limits.window_started_at END
    RETURNING attempts`)
    .bind(bucket, now, AUTH_WINDOW_MS, now, AUTH_WINDOW_MS, now, now).first();
  const attempts = Number(row?.attempts || 0);
  if (attempts > limit) throw new PilotHttpError(429, message);
  if (attempts === 1) {
    await db.prepare('DELETE FROM auth_limits WHERE window_started_at < ?').bind(now - RATE_LIMIT_STALE_MS).run();
  }
}

export async function createPilotSession(db, userId) {
  const token = `v2.${randomToken(32)}`;
  const tokenHash = await hashOpaqueValue(token);
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_SECONDS * 1000;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(createdAt),
    db.prepare(`DELETE FROM sessions
      WHERE user_id = ? AND token_hash NOT IN (
        SELECT token_hash FROM sessions
        WHERE user_id = ?
        ORDER BY created_at DESC, token_hash DESC
        LIMIT ?
      )`).bind(userId, userId, MAX_ACTIVE_SESSIONS - 1),
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(tokenHash, userId, createdAt, expiresAt),
  ]);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export async function recordAudit(db, eventType, actorUserId = null, subjectUserId = null) {
  if (!AUDIT_EVENT_TYPE_SET.has(eventType)) throw new Error('Unsupported audit event type.');
  await db.prepare('INSERT INTO audit_events (id, event_type, actor_user_id, subject_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), eventType, actorUserId, subjectUserId, Date.now()).run();
}

export async function hashOpaqueValue(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function timingSafeTextEqual(a, b) {
  const left = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(a))));
  const right = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(b))));
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}

export function clearPilotSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function pilotJson(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      ...extraHeaders,
    },
  });
}

export class PilotHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function handlePilotError(error, request) {
  if (error instanceof PilotHttpError) return pilotJson({ error: error.message }, error.status);
  console.error(JSON.stringify({
    event: 'pilot_api_error',
    method: request.method,
    path: new URL(request.url).pathname,
    cfRay: request.headers.get('CF-Ray') || null,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  }));
  return pilotJson({ error: 'Unexpected server error.' }, 500);
}

async function derivePassword(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, keyMaterial, 256);
  return bytesToBase64Url(new Uint8Array(bits));
}

function cookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function randomToken(bytes) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(value || ''))) throw new Error('Invalid base64url');
  const text = String(value);
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeAscii(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
