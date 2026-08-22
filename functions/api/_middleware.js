import {
  validateDisplayName,
  validateMessage,
  validatePassword,
  validateReaction,
  validateSearch,
  validateUsername,
} from '../../shared/chat.js';

const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export async function onRequest(context) {
  const { request } = context;
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
    if (method === 'GET' && parts[0] === 'messages') {
      validateSearch(url.searchParams.get('q') || '');
      const cursor = url.searchParams.get('cursor');
      if (cursor && cursor.length > 256) throw new Error('Cursor is too long.');
    }

    if (method !== 'GET' && expectsJson(method, parts)) {
      const type = request.headers.get('Content-Type') || '';
      if (type.toLowerCase().startsWith('application/json')) {
        const body = await request.clone().json();
        validatePayload(method, parts, body);
      }
    }
  } catch (error) {
    if (parts[0] === 'auth' && parts[1] === 'login') return apiError(401, 'Invalid username or password.');
    return apiError(400, error instanceof Error ? error.message : 'Invalid request.');
  }

  return context.next();
}

export function routeAllowed(method, parts) {
  if (parts[0] === 'auth' && parts.length === 2) {
    if (parts[1] === 'me') return method === 'GET';
    if (['bootstrap', 'register', 'login', 'logout', 'logout-all', 'logout-others', 'change-password'].includes(parts[1])) return method === 'POST';
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