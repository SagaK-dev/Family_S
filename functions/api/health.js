import { handlePilotError, pilotJson } from './_security.js';

const REQUIRED_TABLES = ['users', 'sessions', 'blocked_users', 'invites', 'messages', 'reactions', 'reads', 'auth_limits', 'audit_events'];

export async function onRequestGet({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ ok: false, error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const placeholders = REQUIRED_TABLES.map(() => '?').join(',');
    const row = await env.FAMILY_DB.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
      .bind(...REQUIRED_TABLES).first();
    const ready = Number(row?.count || 0) === REQUIRED_TABLES.length;
    return pilotJson({ ok: ready, schema: 'pilot-v2' }, ready ? 200 : 503);
  } catch (error) {
    return handlePilotError(error, request);
  }
}
