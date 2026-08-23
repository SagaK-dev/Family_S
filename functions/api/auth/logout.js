import {
  clearPilotSessionCookie,
  handlePilotError,
  hashOpaqueValue,
  pilotJson,
} from '../_security.js';

const SESSION_RE = /^v2\.[A-Za-z0-9_-]{43}$/;

export async function onRequestPost({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503, { 'Set-Cookie': clearPilotSessionCookie() });
  try {
    const token = readSessionCookie(request);
    if (token && SESSION_RE.test(token)) {
      await env.FAMILY_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashOpaqueValue(token)).run();
    }
    return pilotJson({ ok: true }, 200, { 'Set-Cookie': clearPilotSessionCookie() });
  } catch (error) {
    const response = handlePilotError(error, request);
    response.headers.set('Set-Cookie', clearPilotSessionCookie());
    return response;
  }
}

function readSessionCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === '__Host-family_s_session') return part.slice(index + 1).trim();
  }
  return null;
}
