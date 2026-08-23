import { validateUsername } from '../../../shared/chat.js';
import {
  PilotHttpError,
  clearLoginAttempt,
  consumeLoginAttempts,
  createPilotSession,
  handlePilotError,
  hashPilotPassword,
  pilotJson,
  publicPilotUser,
  verifyPilotLoginPassword,
} from '../_security.js';

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const body = await request.json();
    const username = validateUsername(body?.username);
    const password = String(body?.password || '');
    if (password.length < 1 || password.length > 128) throw new PilotHttpError(401, 'Invalid username or password.');

    const { credentialBucket } = await consumeLoginAttempts(request, env.FAMILY_DB, username);
    const user = await env.FAMILY_DB.prepare(`
      SELECT u.* FROM users u
      LEFT JOIN blocked_users b ON b.user_id = u.id
      WHERE u.username = ? COLLATE NOCASE AND b.user_id IS NULL`)
      .bind(username).first();
    const verification = await verifyPilotLoginPassword(password, user);
    if (!verification.valid) throw new PilotHttpError(401, 'Invalid username or password.');

    await clearLoginAttempt(env.FAMILY_DB, credentialBucket);
    if (verification.needsUpgrade) {
      const upgraded = await hashPilotPassword(password);
      await env.FAMILY_DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
        .bind(upgraded.hash, upgraded.salt, user.id).run();
    }

    const cookie = await createPilotSession(env.FAMILY_DB, user.id);
    return pilotJson({ user: publicPilotUser(user) }, 200, { 'Set-Cookie': cookie });
  } catch (error) {
    if (error instanceof PilotHttpError && error.status === 401) {
      return pilotJson({ error: 'Invalid username or password.' }, 401);
    }
    return handlePilotError(error, request);
  }
}
