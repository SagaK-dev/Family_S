import { handlePilotError, pilotJson } from './_security.js';

const REQUIRED_TABLES = ['users', 'sessions', 'blocked_users', 'invites', 'messages', 'reactions', 'reads', 'auth_limits', 'audit_events'];
const REQUIRED_TRIGGERS = [
  'trg_reads_clamp_insert',
  'trg_reads_clamp_update',
  'trg_audit_events_type_insert',
  'trg_audit_events_type_update',
  'trg_audit_events_guard_update',
  'trg_audit_events_guard_delete',
];
const REQUIRED_INDEXES = [
  'idx_auth_limits_window_started_at',
  'idx_sessions_user_created',
  'idx_invites_created_by',
  'idx_messages_user',
  'idx_messages_pinned_by',
  'idx_reactions_user',
  'idx_audit_events_subject',
];

export async function onRequestGet({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ ok: false, error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const tablePlaceholders = REQUIRED_TABLES.map(() => '?').join(',');
    const triggerPlaceholders = REQUIRED_TRIGGERS.map(() => '?').join(',');
    const indexPlaceholders = REQUIRED_INDEXES.map(() => '?').join(',');
    const [tables, triggers, indexes] = await env.FAMILY_DB.batch([
      env.FAMILY_DB.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${tablePlaceholders})`)
        .bind(...REQUIRED_TABLES),
      env.FAMILY_DB.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerPlaceholders})`)
        .bind(...REQUIRED_TRIGGERS),
      env.FAMILY_DB.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN (${indexPlaceholders})`)
        .bind(...REQUIRED_INDEXES),
    ]);
    const tableCount = Number(tables?.results?.[0]?.count || 0);
    const triggerCount = Number(triggers?.results?.[0]?.count || 0);
    const indexCount = Number(indexes?.results?.[0]?.count || 0);
    const ready = tableCount === REQUIRED_TABLES.length
      && triggerCount === REQUIRED_TRIGGERS.length
      && indexCount === REQUIRED_INDEXES.length;
    return pilotJson({ ok: ready, schema: 'pilot-v4' }, ready ? 200 : 503);
  } catch (error) {
    return handlePilotError(error, request);
  }
}
