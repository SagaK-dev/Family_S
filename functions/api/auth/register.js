import { validateDisplayName, validatePassword, validateUsername } from '../../../shared/chat.js';
import {
  PilotHttpError,
  createPilotSession,
  handlePilotError,
  hashOpaqueValue,
  hashPilotPassword,
  pilotJson,
  publicPilotUser,
} from '../_security.js';

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const body = await request.json();
    const username = validateUsername(body?.username);
    const displayName = validateDisplayName(body?.displayName);
    const password = validatePassword(body?.password);
    const inviteCode = String(body?.inviteCode || '').trim();
    if (inviteCode.length < 16 || inviteCode.length > 128) throw new PilotHttpError(400, 'Invalid invite code.');

    const codeHash = await hashOpaqueValue(inviteCode);
    const passwordRecord = await hashPilotPassword(password);
    const now = Date.now();
    const user = {
      id: crypto.randomUUID(),
      username,
      display_name: displayName,
      role: 'member',
      created_at: now,
    };

    let results;
    try {
      results = await env.FAMILY_DB.batch([
        env.FAMILY_DB.prepare(`
          UPDATE invites SET used_at = ?
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`)
          .bind(now, codeHash, now),
        env.FAMILY_DB.prepare(`
          INSERT INTO users (id, username, display_name, password_hash, password_salt, role, created_at)
          SELECT ?, ?, ?, ?, ?, 'member', ?
          WHERE EXISTS (
            SELECT 1 FROM invites WHERE code_hash = ? AND used_at = ?
          )`)
          .bind(user.id, user.username, user.display_name, passwordRecord.hash, passwordRecord.salt, user.created_at, codeHash, now),
      ]);
    } catch (error) {
      if (String(error?.message || error).toLowerCase().includes('unique')) {
        throw new PilotHttpError(409, 'Username is already in use.');
      }
      throw error;
    }

    const inviteChanges = Number(results?.[0]?.meta?.changes || 0);
    const userChanges = Number(results?.[1]?.meta?.changes || 0);
    if (inviteChanges !== 1 || userChanges !== 1) throw new PilotHttpError(400, 'Invite is invalid, expired, or already used.');

    const cookie = await createPilotSession(env.FAMILY_DB, user.id);
    return pilotJson({ user: publicPilotUser(user) }, 201, { 'Set-Cookie': cookie });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
