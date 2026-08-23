import { validateDisplayName, validatePassword, validateUsername } from '../../../shared/chat.js';
import {
  PilotHttpError,
  createPilotSession,
  handlePilotError,
  hashPilotPassword,
  pilotJson,
  publicPilotUser,
  timingSafeTextEqual,
} from '../_security.js';

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    if (!env.FAMILY_SETUP_SECRET) throw new PilotHttpError(503, 'FAMILY_SETUP_SECRET is not configured.');
    const supplied = request.headers.get('X-Family-Setup-Secret') || '';
    if (!(await timingSafeTextEqual(supplied, env.FAMILY_SETUP_SECRET))) throw new PilotHttpError(403, 'Invalid setup secret.');

    const existing = await env.FAMILY_DB.prepare('SELECT COUNT(*) AS count FROM users').first();
    if (Number(existing?.count || 0) > 0) throw new PilotHttpError(409, 'Family space is already initialized.');

    const body = await request.json();
    const username = validateUsername(body?.username);
    const displayName = validateDisplayName(body?.displayName);
    const password = validatePassword(body?.password);
    const passwordRecord = await hashPilotPassword(password);
    const user = {
      id: crypto.randomUUID(),
      username,
      display_name: displayName,
      role: 'owner',
      created_at: Date.now(),
    };

    try {
      await env.FAMILY_DB.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, password_salt, role, created_at)
        VALUES (?, ?, ?, ?, ?, 'owner', ?)`)
        .bind(user.id, user.username, user.display_name, passwordRecord.hash, passwordRecord.salt, user.created_at).run();
    } catch (error) {
      if (String(error?.message || error).toLowerCase().includes('unique')) {
        throw new PilotHttpError(409, 'Family space is already initialized or username is in use.');
      }
      throw error;
    }

    const cookie = await createPilotSession(env.FAMILY_DB, user.id);
    return pilotJson({ user: publicPilotUser(user) }, 201, { 'Set-Cookie': cookie });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
