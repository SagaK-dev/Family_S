import { PilotHttpError, handlePilotError, pilotJson, requirePilotUser } from './_security.js';

export async function onRequestGet({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const user = await requirePilotUser(request, env.FAMILY_DB);
    if (user.role !== 'owner') throw new PilotHttpError(403, 'Only the family owner can view the audit log.');

    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const result = await env.FAMILY_DB.prepare(`
      SELECT a.id, a.event_type, a.created_at,
             actor.display_name AS actor_display_name,
             subject.display_name AS subject_display_name
      FROM audit_events a
      LEFT JOIN users actor ON actor.id = a.actor_user_id
      LEFT JOIN users subject ON subject.id = a.subject_user_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`).bind(limit).all();

    return pilotJson({
      events: (result.results || []).map(row => ({
        id: row.id,
        eventType: row.event_type,
        createdAt: row.created_at,
        actorDisplayName: row.actor_display_name || null,
        subjectDisplayName: row.subject_display_name || null,
      })),
    });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
