import {
  handlePilotError,
  optionalPilotUser,
  pilotJson,
  publicPilotUser,
} from '../_security.js';

export async function onRequestGet({ request, env }) {
  if (!env.FAMILY_DB) return pilotJson({ error: 'Database binding FAMILY_DB is not configured.' }, 503);
  try {
    const user = await optionalPilotUser(request, env.FAMILY_DB);
    return pilotJson({ user: user ? publicPilotUser(user) : null });
  } catch (error) {
    return handlePilotError(error, request);
  }
}
