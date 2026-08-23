import {
  handlePilotError,
  hashOpaqueValue,
  pilotJson,
  readPilotSessionToken,
  requirePilotUser,
} from '../_security.js';

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const user = await requirePilotUser(request, env.FAMILY_DB);
    const tokenHash = await hashOpaqueValue(readPilotSessionToken(request));
    await env.FAMILY_DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .bind(user.id, tokenHash).run();
    return pilotJson({ ok: true });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
