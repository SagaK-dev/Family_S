import {
  clearPilotSessionCookie,
  handlePilotError,
  pilotJson,
  requirePilotUser,
} from '../_security.js';

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const user = await requirePilotUser(request, env.FAMILY_DB);
    await env.FAMILY_DB.batch([
      env.FAMILY_DB.prepare('INSERT INTO audit_events (id, event_type, actor_user_id, subject_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), 'sessions_revoked_all', user.id, user.id, Date.now()),
      env.FAMILY_DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ]);
    return pilotJson({ ok: true }, 200, { 'Set-Cookie': clearPilotSessionCookie() });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
