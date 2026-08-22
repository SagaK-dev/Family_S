const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return context.next();

  const allowed = routeAllowed(method, parts);
  if (!allowed) return apiError(404, 'Not found.');

  if (method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return apiError(403, 'Cross-site request rejected.');
  }

  if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'login') {
    try {
      const body = await request.clone().json();
      const password = String(body?.password ?? '');
      if (password.length > 128) return apiError(401, 'Invalid username or password.');
    } catch {
      // The route handler provides the canonical invalid-JSON response.
    }
  }

  return context.next();
}

function routeAllowed(method, parts) {
  if (parts[0] === 'auth' && parts.length === 2) {
    if (parts[1] === 'me') return method === 'GET';
    if (['bootstrap', 'register', 'login', 'logout'].includes(parts[1])) return method === 'POST';
    return false;
  }

  if (parts[0] === 'messages') {
    if (parts.length === 1) return method === 'GET' || method === 'POST';
    if (parts.length === 2 && MESSAGE_ID_RE.test(parts[1])) return method === 'PATCH' || method === 'DELETE';
    if (parts.length === 3 && MESSAGE_ID_RE.test(parts[1]) && parts[2] === 'pin') return method === 'POST';
    return false;
  }

  if (parts.length !== 1) return false;
  if (parts[0] === 'members') return method === 'GET';
  if (['reactions', 'read', 'invites'].includes(parts[0])) return method === 'POST';
  return false;
}

function apiError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
