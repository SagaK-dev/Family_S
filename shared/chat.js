export const USERNAME_RE = /^[a-z0-9_]{3,24}$/i;
export const ALLOWED_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

export function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_RE.test(username)) throw new Error('Username must be 3–24 letters, numbers, or underscores.');
  return username;
}

export function validateDisplayName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 1 || name.length > 40) throw new Error('Display name must be 1–40 characters.');
  return name;
}

export function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < 10 || password.length > 128) throw new Error('Password must be 10–128 characters.');
  return password;
}

export function validateMessage(value) {
  const body = String(value ?? '').trim();
  if (body.length < 1 || body.length > 2000) throw new Error('Message must be 1–2000 characters.');
  return body;
}

export function validateSearch(value) {
  const query = String(value ?? '').trim();
  if (query.length > 100) throw new Error('Search text is too long.');
  return query;
}

export function validateReaction(value) {
  const emoji = String(value ?? '');
  if (!ALLOWED_REACTIONS.includes(emoji)) throw new Error('Unsupported reaction.');
  return emoji;
}

export function encodeCursor(message) {
  if (!message?.createdAt || !message?.id) return null;
  return base64UrlEncode(JSON.stringify([message.createdAt, message.id]));
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(String(value)));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (!Number.isSafeInteger(createdAt) || typeof id !== 'string' || id.length < 1 || id.length > 80) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function runTimelinePipeline(rows, { limit = 50, currentUserId = null } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const seen = new Set();
  const normalized = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.id !== 'string' || seen.has(row.id)) continue;
    if (row.hidden === true) continue;
    seen.add(row.id);
    normalized.push({ ...row, isMine: currentUserId ? row.userId === currentUserId : false });
  }

  normalized.sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
  return normalized.slice(-safeLimit);
}

export function buildReactionSummary(rows, currentUserId) {
  const byMessage = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.message_id || !ALLOWED_REACTIONS.includes(row.emoji)) continue;
    let map = byMessage.get(row.message_id);
    if (!map) byMessage.set(row.message_id, (map = new Map()));
    let item = map.get(row.emoji);
    if (!item) map.set(row.emoji, (item = { emoji: row.emoji, count: 0, reacted: false }));
    item.count += 1;
    if (row.user_id === currentUserId) item.reacted = true;
  }

  return Object.fromEntries([...byMessage].map(([messageId, map]) => [messageId, [...map.values()]]));
}

function base64UrlEncode(text) {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64url');
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Bad cursor');
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'base64url').toString('utf8');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
