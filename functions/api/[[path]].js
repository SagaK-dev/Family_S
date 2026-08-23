import {
  buildReactionSummary,
  decodeCursor,
  encodeCursor,
  runTimelinePipeline,
  validateDisplayName,
  validateMessage,
  validatePassword,
  validateReaction,
  validateSearch,
  validateUsername,
} from '../../shared/chat.js';

export const SESSION_COOKIE = '__Host-family_s_session';
export const PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 240_000;
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const JSON_LIMIT = 16 * 1024;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const DUMMY_SALT = new Uint8Array([73, 28, 244, 11, 91, 167, 35, 214, 64, 202, 17, 121, 8, 99, 188, 51]);
const DUMMY_DIGEST = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const INVITE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.FAMILY_DB) return json({ error: 'Database binding FAMILY_DB is not configured.' }, 503);

  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: apiHeaders() });
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

    if (request.method !== 'GET') assertSameOrigin(request);

    if (parts[0] === 'auth') return handleAuth(request, env, parts.slice(1));

    const user = await requireUser(request, env.FAMILY_DB);

    if (parts[0] === 'messages') return handleMessages(request, env.FAMILY_DB, user, parts.slice(1), url);
    if (parts[0] === 'reactions') return handleReactions(request, env.FAMILY_DB, user);
    if (parts[0] === 'read') return handleRead(request, env.FAMILY_DB, user);
    if (parts[0] === 'members') return handleMembers(request, env.FAMILY_DB, user, parts.slice(1));
    if (parts[0] === 'invites') return handleInvites(request, env.FAMILY_DB, user, parts.slice(1));

    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error('Family_S API error', error);
    return json({ error: 'Unexpected server error.' }, 500);
  }
}

async function handleAuth(request, env, parts) {
  const action = parts[0] || '';
  if (action === 'me' && request.method === 'GET') {
    const user = await optionalUser(request, env.FAMILY_DB);
    return json({ user: user ? publicUser(user) : null });
  }

  if (action === 'bootstrap' && request.method === 'POST') {
    if (!env.FAMILY_SETUP_SECRET) throw new HttpError(503, 'FAMILY_SETUP_SECRET is not configured.');
    const existing = await env.FAMILY_DB.prepare('SELECT COUNT(*) AS count FROM users').first();
    if (Number(existing?.count || 0) > 0) throw new HttpError(409, 'Family space is already initialized.');
    const supplied = request.headers.get('X-Family-Setup-Secret') || '';
    if (!(await constantTimeEqual(supplied, env.FAMILY_SETUP_SECRET))) throw new HttpError(403, 'Invalid setup secret.');
    const body = await readJson(request);
    const username = validateUsername(body.username);
    const displayName = validateDisplayName(body.displayName);
    const password = validatePassword(body.password);
    const user = await createUser(env.FAMILY_DB, { username, displayName, password, role: 'owner' });
    const cookie = await createSession(env.FAMILY_DB, user.id);
    return json({ user: publicUser(user) }, 201, { 'Set-Cookie': cookie });
  }

  if (action === 'register' && request.method === 'POST') {
    const body = await readJson(request);
    const username = validateUsername(body.username);
    const displayName = validateDisplayName(body.displayName);
    const password = validatePassword(body.password);
    const inviteCode = String(body.inviteCode || '').trim();
    if (inviteCode.length < 16 || inviteCode.length > 128) throw new HttpError(400, 'Invalid invite code.');
    const codeHash = await sha256Text(inviteCode);
    const now = Date.now();
    const invite = await env.FAMILY_DB.prepare('SELECT * FROM invites WHERE code_hash = ?').bind(codeHash).first();
    if (!invite || invite.used_at || invite.expires_at <= now) throw new HttpError(400, 'Invite is invalid or expired.');

    const user = await createUser(env.FAMILY_DB, { username, displayName, password, role: 'member' });
    const result = await env.FAMILY_DB.prepare('UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').bind(now, codeHash, now).run();
    if (!result.meta?.changes) {
      await env.FAMILY_DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
      throw new HttpError(409, 'Invite was already used or expired.');
    }
    const cookie = await createSession(env.FAMILY_DB, user.id);
    return json({ user: publicUser(user) }, 201, { 'Set-Cookie': cookie });
  }

  if (action === 'login' && request.method === 'POST') {
    const body = await readJson(request);
    const username = validateUsername(body.username);
    const password = String(body.password || '');
    if (password.length < 1 || password.length > 128) throw new HttpError(401, 'Invalid username or password.');
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipBucket = await sha256Text(`ip\n${ip}`);
    const credentialBucket = await sha256Text(`ip-user\n${ip}\n${username}`);

    await consumeAuthAttempt(env.FAMILY_DB, ipBucket, 60);
    await consumeAuthAttempt(env.FAMILY_DB, credentialBucket, 10);

    const user = await env.FAMILY_DB.prepare(`
      SELECT u.* FROM users u
      LEFT JOIN blocked_users b ON b.user_id = u.id
      WHERE u.username = ? COLLATE NOCASE AND b.user_id IS NULL`).bind(username).first();
    const verification = await verifyPasswordForLogin(password, user);
    if (!verification.valid) throw new HttpError(401, 'Invalid username or password.');

    await env.FAMILY_DB.prepare('DELETE FROM auth_limits WHERE bucket_hash = ?').bind(credentialBucket).run();
    if (verification.needsUpgrade) {
      const upgraded = await hashPassword(password);
      await env.FAMILY_DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
        .bind(upgraded.hash, upgraded.salt, user.id).run();
    }
    const cookie = await createSession(env.FAMILY_DB, user.id);
    return json({ user: publicUser(user) }, 200, { 'Set-Cookie': cookie });
  }

  if (action === 'logout' && request.method === 'POST') {
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) await env.FAMILY_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Text(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  if (action === 'logout-others' && request.method === 'POST') {
    const user = await requireUser(request, env.FAMILY_DB);
    const token = requireSessionToken(request);
    const tokenHash = await sha256Text(token);
    await env.FAMILY_DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, tokenHash).run();
    return json({ ok: true });
  }

  if (action === 'logout-all' && request.method === 'POST') {
    const user = await requireUser(request, env.FAMILY_DB);
    await env.FAMILY_DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  if (action === 'change-password' && request.method === 'POST') {
    const user = await requireUser(request, env.FAMILY_DB);
    const body = await readJson(request);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = validatePassword(body.newPassword);
    if (currentPassword.length < 1 || currentPassword.length > 128 || currentPassword === newPassword) {
      throw new HttpError(400, 'Invalid password change request.');
    }
    const verification = await verifyPassword(currentPassword, user.password_salt, user.password_hash);
    if (!verification.valid) throw new HttpError(401, 'Current password is incorrect.');
    const replacement = await hashPassword(newPassword);
    await env.FAMILY_DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .bind(replacement.hash, replacement.salt, user.id).run();
    await env.FAMILY_DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    const cookie = await createSession(env.FAMILY_DB, user.id);
    return json({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': cookie });
  }

  throw new HttpError(404, 'Not found.');
}

async function handleMessages(request, db, user, parts, url) {
  if (request.method === 'GET' && parts.length === 0) {
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const query = validateSearch(url.searchParams.get('q') || '');
    const pinnedOnly = url.searchParams.get('pinned') === '1';

    const clauses = ['m.deleted_at IS NULL'];
    const bindings = [];
    if (cursor) {
      clauses.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    if (query) {
      clauses.push("m.body LIKE ? ESCAPE '\\'");
      bindings.push(`%${escapeLike(query)}%`);
    }
    if (pinnedOnly) clauses.push('m.pinned_at IS NOT NULL');

    const sql = `
      SELECT m.id, m.user_id, m.body, m.reply_to, m.created_at, m.edited_at, m.pinned_at,
             u.username, u.display_name,
             rm.body AS reply_body, ru.display_name AS reply_display_name,
             (SELECT COUNT(*) FROM reads rd WHERE rd.user_id != m.user_id AND rd.last_message_at >= m.created_at) AS seen_count
      FROM messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN messages rm ON rm.id = m.reply_to AND rm.deleted_at IS NULL
      LEFT JOIN users ru ON ru.id = rm.user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`;
    bindings.push(limit + 1);

    const result = await db.prepare(sql).bind(...bindings).all();
    const rawRows = result.results || [];
    const hasMore = rawRows.length > limit;
    const selected = rawRows.slice(0, limit).map(row => ({
      id: row.id,
      userId: row.user_id,
      body: row.body,
      replyTo: row.reply_to,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      pinnedAt: row.pinned_at,
      username: row.username,
      displayName: row.display_name,
      replyBody: row.reply_body,
      replyDisplayName: row.reply_display_name,
      seenCount: Number(row.seen_count || 0),
    }));
    const messages = runTimelinePipeline(selected, { limit, currentUserId: user.id });

    let reactions = {};
    if (messages.length) {
      const placeholders = messages.map(() => '?').join(',');
      const reactionRows = await db.prepare(`SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${placeholders})`).bind(...messages.map(message => message.id)).all();
      reactions = buildReactionSummary(reactionRows.results || [], user.id);
    }

    const oldest = messages[0];
    return json({ messages, reactions, nextCursor: hasMore && oldest ? encodeCursor(oldest) : null });
  }

  if (request.method === 'POST' && parts.length === 0) {
    const body = await readJson(request);
    const text = validateMessage(body.body);
    const replyTo = body.replyTo ? String(body.replyTo) : null;
    const now = Date.now();
    const recent = await db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ? AND created_at > ?').bind(user.id, now - 10_000).first();
    if (Number(recent?.count || 0) >= 12) throw new HttpError(429, 'You are sending messages too quickly.');
    if (replyTo) {
      const parent = await db.prepare('SELECT id FROM messages WHERE id = ? AND deleted_at IS NULL').bind(replyTo).first();
      if (!parent) throw new HttpError(400, 'Reply target does not exist.');
    }
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO messages (id, user_id, body, reply_to, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, user.id, text, replyTo, now).run();
    return json({ id, createdAt: now }, 201);
  }

  const messageId = parts[0] ? String(parts[0]) : '';
  if (!messageId || messageId.length > 80) throw new HttpError(404, 'Message not found.');

  if (request.method === 'PATCH' && parts[1] !== 'pin') {
    const body = await readJson(request);
    const text = validateMessage(body.body);
    const message = await db.prepare('SELECT user_id, deleted_at FROM messages WHERE id = ?').bind(messageId).first();
    if (!message || message.deleted_at) throw new HttpError(404, 'Message not found.');
    if (message.user_id !== user.id) throw new HttpError(403, 'You can only edit your own messages.');
    await db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').bind(text, Date.now(), messageId).run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const message = await db.prepare('SELECT user_id, deleted_at FROM messages WHERE id = ?').bind(messageId).first();
    if (!message || message.deleted_at) throw new HttpError(404, 'Message not found.');
    if (message.user_id !== user.id && user.role !== 'owner') throw new HttpError(403, 'Not allowed.');
    await db.prepare('UPDATE messages SET body = ?, deleted_at = ?, pinned_at = NULL, pinned_by = NULL WHERE id = ?').bind('', Date.now(), messageId).run();
    return json({ ok: true });
  }

  if (request.method === 'POST' && parts[1] === 'pin') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the family owner can pin messages.');
    const body = await readJson(request);
    if (typeof body.pinned !== 'boolean') throw new HttpError(400, 'Pinned must be a boolean.');
    const message = await db.prepare('SELECT id FROM messages WHERE id = ? AND deleted_at IS NULL').bind(messageId).first();
    if (!message) throw new HttpError(404, 'Message not found.');
    await db.prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?').bind(body.pinned ? Date.now() : null, body.pinned ? user.id : null, messageId).run();
    return json({ ok: true });
  }

  throw new HttpError(405, 'Method not allowed.');
}

async function handleReactions(request, db, user) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const body = await readJson(request);
  const messageId = String(body.messageId || '');
  const emoji = validateReaction(body.emoji);
  const message = await db.prepare('SELECT id FROM messages WHERE id = ? AND deleted_at IS NULL').bind(messageId).first();
  if (!message) throw new HttpError(404, 'Message not found.');
  const existing = await db.prepare('SELECT 1 AS found FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').bind(messageId, user.id, emoji).first();
  if (existing) {
    await db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').bind(messageId, user.id, emoji).run();
    return json({ reacted: false });
  }
  await db.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').bind(messageId, user.id, emoji, Date.now()).run();
  return json({ reacted: true });
}

async function handleRead(request, db, user) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const body = await readJson(request);
  const value = Number(body.lastMessageAt);
  if (!Number.isSafeInteger(value) || value < 0 || value > Date.now()) throw new HttpError(400, 'Invalid read marker.');
  const now = Date.now();
  await db.prepare(`
    INSERT INTO reads (user_id, last_message_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_message_at = MAX(reads.last_message_at, excluded.last_message_at),
      updated_at = excluded.updated_at`).bind(user.id, value, now).run();
  return json({ ok: true });
}

async function handleMembers(request, db, user, parts) {
  if (request.method === 'GET' && parts.length === 0) {
    const result = await db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.created_at,
             r.updated_at AS last_read_at,
             CASE WHEN b.user_id IS NULL THEN 0 ELSE 1 END AS disabled
      FROM users u
      LEFT JOIN reads r ON r.user_id = u.id
      LEFT JOIN blocked_users b ON b.user_id = u.id
      ORDER BY CASE u.role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name COLLATE NOCASE`).all();
    return json({ members: (result.results || []).map(row => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at,
      lastReadAt: row.last_read_at,
      disabled: Boolean(row.disabled),
    })) });
  }

  if (parts.length === 2 && parts[1] === 'disable' && (request.method === 'POST' || request.method === 'DELETE')) {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the family owner can manage members.');
    const targetId = String(parts[0] || '');
    const target = await db.prepare('SELECT id, role FROM users WHERE id = ?').bind(targetId).first();
    if (!target || target.role === 'owner' || target.id === user.id) throw new HttpError(400, 'This member cannot be changed.');
    if (request.method === 'POST') {
      await db.prepare(`INSERT INTO blocked_users (user_id, disabled_at, disabled_by) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET disabled_at = excluded.disabled_at, disabled_by = excluded.disabled_by`)
        .bind(targetId, Date.now(), user.id).run();
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId).run();
      return json({ ok: true, disabled: true });
    }
    await db.prepare('DELETE FROM blocked_users WHERE user_id = ?').bind(targetId).run();
    return json({ ok: true, disabled: false });
  }

  throw new HttpError(405, 'Method not allowed.');
}

async function handleInvites(request, db, user, parts) {
  if (user.role !== 'owner') throw new HttpError(403, 'Only the family owner can manage invites.');
  const now = Date.now();
  if (request.method === 'GET' && parts.length === 0) {
    const result = await db.prepare(`SELECT code_hash, created_at, expires_at
      FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 50`).bind(now).all();
    return json({ invites: (result.results || []).map(row => ({
      id: row.code_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    })) });
  }
  if (request.method === 'POST' && parts.length === 0) {
    const rawCode = randomToken(24);
    const codeHash = await sha256Text(rawCode);
    const expiresAt = now + 60 * 60 * 1000;
    await db.prepare('INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(codeHash, user.id, now, expiresAt).run();
    return json({ inviteCode: rawCode, inviteId: codeHash, expiresAt }, 201);
  }
  if (request.method === 'DELETE' && parts.length === 1 && INVITE_ID_RE.test(parts[0])) {
    const result = await db.prepare('DELETE FROM invites WHERE code_hash = ? AND used_at IS NULL').bind(parts[0]).run();
    if (!result.meta?.changes) throw new HttpError(404, 'Active invite not found.');
    return json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed.');
}

async function createUser(db, { username, displayName, password, role }) {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const { salt, hash } = await hashPassword(password);
  try {
    await db.prepare('INSERT INTO users (id, username, display_name, password_hash, password_salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, username, displayName, hash, salt, role, createdAt).run();
  } catch (error) {
    if (String(error?.message || error).toLowerCase().includes('unique')) throw new HttpError(409, 'Username is already in use.');
    throw error;
  }
  return { id, username, display_name: displayName, role, created_at: createdAt };
}

async function createSession(db, userId) {
  const token = `v2.${randomToken(32)}`;
  const tokenHash = await sha256Text(token);
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_SECONDS * 1000;
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(createdAt).run();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(tokenHash, userId, createdAt, expiresAt).run();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function requireSessionToken(request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^v2\.[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Authentication required.');
  return token;
}

async function requireUser(request, db) {
  const user = await optionalUser(request, db);
  if (!user) throw new HttpError(401, 'Authentication required.');
  return user;
}

async function optionalUser(request, db) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^v2\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const now = Date.now();
  const user = await db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN blocked_users b ON b.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND b.user_id IS NULL`)
    .bind(await sha256Text(token), now).first();
  return user || null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
  };
}

async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToBase64Url(saltBytes);
  const digest = await derivePassword(password, saltBytes, PBKDF2_ITERATIONS);
  return { salt, hash: `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${digest}` };
}

export function parsePasswordHash(storedHash) {
  const value = String(storedHash || '');
  const match = /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9_-]{43})$/.exec(value);
  if (match) {
    const iterations = Number(match[1]);
    if (!Number.isSafeInteger(iterations) || iterations < LEGACY_PBKDF2_ITERATIONS || iterations > 1_000_000) throw new Error('Invalid password hash parameters.');
    return { iterations, digest: match[2], needsUpgrade: iterations < PBKDF2_ITERATIONS };
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return { iterations: LEGACY_PBKDF2_ITERATIONS, digest: value, needsUpgrade: true };
  }
  throw new Error('Invalid password hash format.');
}

async function verifyPassword(password, salt, expectedHash) {
  try {
    const saltBytes = base64UrlToBytes(salt);
    const parsed = parsePasswordHash(expectedHash);
    const actual = await derivePassword(password, saltBytes, parsed.iterations);
    return { valid: constantTimeAscii(actual, parsed.digest), needsUpgrade: parsed.needsUpgrade };
  } catch {
    return { valid: false, needsUpgrade: false };
  }
}

async function verifyPasswordForLogin(password, user) {
  if (!user) {
    const actual = await derivePassword(password, DUMMY_SALT, PBKDF2_ITERATIONS);
    constantTimeAscii(actual, DUMMY_DIGEST);
    return { valid: false, needsUpgrade: false };
  }
  return verifyPassword(password, user.password_salt, user.password_hash);
}

async function derivePassword(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, keyMaterial, 256);
  return bytesToBase64Url(new Uint8Array(bits));
}

async function consumeAuthAttempt(db, bucket, limit) {
  const now = Date.now();
  const row = await db.prepare(`
    INSERT INTO auth_limits (bucket_hash, attempts, window_started_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_hash) DO UPDATE SET
      attempts = CASE WHEN auth_limits.window_started_at + ? <= ? THEN 1 ELSE auth_limits.attempts + 1 END,
      window_started_at = CASE WHEN auth_limits.window_started_at + ? <= ? THEN ? ELSE auth_limits.window_started_at END
    RETURNING attempts, window_started_at`)
    .bind(bucket, now, AUTH_WINDOW_MS, now, AUTH_WINDOW_MS, now, now).first();
  if (Number(row?.attempts || 0) > limit) throw new HttpError(429, 'Too many login attempts. Try again later.');
  if (Math.random() < 0.02) {
    await db.prepare('DELETE FROM auth_limits WHERE window_started_at < ?').bind(now - 24 * 60 * 60 * 1000).run();
  }
}

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json.');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > JSON_LIMIT) throw new HttpError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > JSON_LIMIT) {
      await reader.cancel();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes) || '{}'); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function assertSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Cross-site request rejected.');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) throw new HttpError(403, 'Cross-site request rejected.');
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

function escapeLike(value) {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function constantTimeEqual(a, b) {
  const da = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(a)));
  const db = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(b)));
  const aa = new Uint8Array(da); const bb = new Uint8Array(db);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.min(aa.length, bb.length); i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function constantTimeAscii(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function randomToken(bytes) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function apiHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...apiHeaders(extraHeaders) },
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}