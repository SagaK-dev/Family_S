import { handlePilotError, pilotJson } from './_security.js';

const REQUIRED_TABLES = ['users', 'sessions', 'blocked_users', 'invites', 'messages', 'reactions', 'reads', 'auth_limits', 'audit_events'];
const REQUIRED_TRIGGERS = ['trg_reads_clamp_insert', 'trg_reads_clamp_update', 'trg_audit_events_type_insert', 'trg_audit_events_type_update'];

export async function onRequestGet({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ ok: false, error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const tablePlaceholders = REQUIRED_TABLES.map(() => '?').join(',');
    const triggerPlaceholders = REQUIRED_TRIGGERS.map(() => '?').join(',');
    const [tables, triggers] = await env.FAMILY_DB.batch([
      env.FAMILY_DB.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${tablePlaceholders})`)
        .bind(...REQUIRED_TABLES),
      env.FAMILY_DB.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerPlaceholders})`)
        .bind(...REQUIRED_TRIGGERS),
    ]);
    const tableCount = Number(tables?.results?.[0]?.count || 0);
    const triggerCount = Number(triggers?.results?.[0]?.count || 0);
    const ready = tableCount === REQUIRED_TABLES.length && triggerCount === REQUIRED_TRIGGERS.length;
    return pilotJson({ ok: ready, schema: 'pilot-v3' }, ready ? 200 : 503);
  } catch (error) {
    return handlePilotError(error, request);
  }
}
