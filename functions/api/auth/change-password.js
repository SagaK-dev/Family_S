import {
  PilotHttpError,
  clearSensitiveAttempt,
  consumeSensitiveAttempt,
  createPilotSession,
  handlePilotError,
  hashPilotPassword,
  pilotJson,
  requirePilotUser,
  verifyPilotPassword,
} from '../_security.js';

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const user = await requirePilotUser(request, env.FAMILY_DB);
    const body = await request.json();
    const currentPassword = String(body?.currentPassword || '');
    const newPassword = String(body?.newPassword || '');
    if (currentPassword.length < 1 || currentPassword.length > 128 || newPassword.length < 10 || newPassword.length > 128 || currentPassword === newPassword) {
      throw new PilotHttpError(400, 'Invalid password change request.');
    }

    const bucket = await consumeSensitiveAttempt(request, env.FAMILY_DB, user.id, 'change-password');
    if (!(await verifyPilotPassword(currentPassword, user))) throw new PilotHttpError(401, 'Current password is incorrect.');

    const replacement = await hashPilotPassword(newPassword);
    const auditId = crypto.randomUUID();
    const now = Date.now();
    await env.FAMILY_DB.batch([
      env.FAMILY_DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(replacement.hash, replacement.salt, user.id),
      env.FAMILY_DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      env.FAMILY_DB.prepare('INSERT INTO audit_events (id, event_type, actor_user_id, subject_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(auditId, 'password_changed', user.id, user.id, now),
    ]);
    await clearSensitiveAttempt(env.FAMILY_DB, bucket);
    const cookie = await createPilotSession(env.FAMILY_DB, user.id);
    return pilotJson({ ok: true }, 200, { 'Set-Cookie': cookie });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
