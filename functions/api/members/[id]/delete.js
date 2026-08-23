import {
  PilotHttpError,
  consumeSensitiveAttempt,
  handlePilotError,
  pilotJson,
  requirePilotUser,
  verifyPilotPassword,
} from '../../_security.js';

export async function onRequestPost({ request, env, params }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const owner = await requirePilotUser(request, env.FAMILY_DB);
    if (owner.role !== 'owner') throw new PilotHttpError(403, 'Only the family owner can delete a member.');

    const targetId = String(params?.id || '');
    const target = await env.FAMILY_DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(targetId).first();
    if (!target || target.role !== 'member' || target.id === owner.id) throw new PilotHttpError(400, 'This member cannot be deleted.');

    const body = await request.json();
    const currentPassword = String(body?.currentPassword || '');
    const confirmation = String(body?.confirmation || '');
    if (currentPassword.length < 1 || currentPassword.length > 128 || confirmation !== 'DELETE') {
      throw new PilotHttpError(400, 'Member deletion confirmation is invalid.');
    }

    const bucket = await consumeSensitiveAttempt(request, env.FAMILY_DB, owner.id, 'delete-member', 5);
    if (!(await verifyPilotPassword(currentPassword, owner))) throw new PilotHttpError(401, 'Current password is incorrect.');

    const results = await env.FAMILY_DB.batch([
      env.FAMILY_DB.prepare('INSERT INTO audit_events (id, event_type, actor_user_id, subject_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), 'member_deleted', owner.id, target.id, Date.now()),
      env.FAMILY_DB.prepare("DELETE FROM users WHERE id = ? AND role = 'member'").bind(target.id),
      env.FAMILY_DB.prepare('DELETE FROM auth_limits WHERE bucket_hash = ?').bind(bucket),
    ]);
    if (Number(results?.[1]?.meta?.changes || 0) !== 1) throw new PilotHttpError(409, 'Member deletion did not complete.');
    return pilotJson({ ok: true, deleted: true });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
