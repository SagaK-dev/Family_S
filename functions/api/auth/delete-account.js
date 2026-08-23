import {
  PilotHttpError,
  clearPilotSessionCookie,
  consumeSensitiveAttempt,
  handlePilotError,
  pilotJson,
  requirePilotUser,
  verifyPilotPassword,
} from '../_security.js';

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const user = await requirePilotUser(request, env.FAMILY_DB);
    if (user.role === 'owner') throw new PilotHttpError(409, 'The owner account cannot be deleted from this endpoint.');

    const body = await request.json();
    const currentPassword = String(body?.currentPassword || '');
    const confirmation = String(body?.confirmation || '');
    if (currentPassword.length < 1 || currentPassword.length > 128 || confirmation !== 'DELETE') {
      throw new PilotHttpError(400, 'Account deletion confirmation is invalid.');
    }

    const bucket = await consumeSensitiveAttempt(request, env.FAMILY_DB, user.id, 'delete-account', 5);
    if (!(await verifyPilotPassword(currentPassword, user))) throw new PilotHttpError(401, 'Current password is incorrect.');

    const auditId = crypto.randomUUID();
    const now = Date.now();
    const results = await env.FAMILY_DB.batch([
      env.FAMILY_DB.prepare('INSERT INTO audit_events (id, event_type, actor_user_id, subject_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(auditId, 'account_deleted', user.id, user.id, now),
      env.FAMILY_DB.prepare("DELETE FROM users WHERE id = ? AND role = 'member'").bind(user.id),
      env.FAMILY_DB.prepare('DELETE FROM auth_limits WHERE bucket_hash = ?').bind(bucket),
    ]);
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) throw new PilotHttpError(409, 'Account deletion did not complete.');

    return pilotJson({ ok: true, deleted: true }, 200, { 'Set-Cookie': clearPilotSessionCookie() });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
