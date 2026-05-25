// worker.js — Cloudflare Workers Backend
// Complete API with D1 Database, JWT Auth, Rate Limiting

// ==================== CONFIG ====================
const JWT_SECRET = (env) => env.JWT_SECRET;
const COOKIE_NAME = 'nexstream_token';
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 100;

// ==================== CORS HEADERS ====================
const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '86400',
});

// ==================== JWT UTILS ====================
async function signJWT(payload, secret) {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const payloadBase64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  return `${payloadBase64}.${sigBase64}`;
}

async function verifyJWT(token, secret) {
  try {
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const payload = Uint8Array.from(atob(payloadB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, payload);
    if (!valid) return null;
    return JSON.parse(new TextDecoder().decode(payload));
  } catch { return null; }
}

// ==================== PASSWORD HASHING ====================
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashArray = new Uint8Array(hash);
  return btoa(String.fromCharCode(...salt)) + '.' + btoa(String.fromCharCode(...hashArray));
}

async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split('.');
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashArray = new Uint8Array(hash);
  const newHashB64 = btoa(String.fromCharCode(...hashArray));
  return newHashB64 === hashB64;
}

// ==================== RATE LIMITING ====================
async function checkRateLimit(request, env) {
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rate_limit:${clientIP}`;
  const now = Date.now();
  const kv = env.NEXSTREAM_KV;
  if (!kv) return true; // Skip if KV not bound
  
  const data = await kv.get(key, { type: 'json' });
  if (!data) {
    await kv.put(key, JSON.stringify({ count: 1, windowStart: now }), { expirationTtl: 60 });
    return true;
  }
  if (now - data.windowStart > RATE_LIMIT_WINDOW) {
    await kv.put(key, JSON.stringify({ count: 1, windowStart: now }), { expirationTtl: 60 });
    return true;
  }
  if (data.count >= MAX_REQUESTS) return false;
  await kv.put(key, JSON.stringify({ count: data.count + 1, windowStart: data.windowStart }), { expirationTtl: 60 });
  return true;
}

// ==================== AUTH MIDDLEWARE ====================
async function authMiddleware(request, env) {
  const cookie = request.headers.get('Cookie');
  const token = cookie?.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))?.[1];
  if (!token) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const bearerToken = authHeader.slice(7);
      const payload = await verifyJWT(bearerToken, JWT_SECRET(env));
      if (payload) return payload;
    }
    return null;
  }
  return await verifyJWT(token, JWT_SECRET(env));
}

// ==================== RESPONSE HELPERS ====================
function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

function errorResponse(message, status = 400, origin) {
  return jsonResponse({ error: message, success: false }, status, origin);
}

// ==================== ROUTER ====================
class Router {
  constructor() { this.routes = []; }
  get(path, handler) { this.routes.push({ method: 'GET', path, handler }); }
  post(path, handler) { this.routes.push({ method: 'POST', path, handler }); }
  put(path, handler) { this.routes.push({ method: 'PUT', path, handler }); }
  delete(path, handler) { this.routes.push({ method: 'DELETE', path, handler }); }
  
  async handle(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    
    // Rate limiting
    const allowed = await checkRateLimit(request, env);
    if (!allowed) return errorResponse('Rate limit exceeded', 429, origin);
    
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const match = this.matchPath(route.path, url.pathname);
      if (match) {
        try {
          return await route.handler(request, env, match.params, origin);
        } catch (err) {
          console.error('Route error:', err);
          return errorResponse('Internal server error', 500, origin);
        }
      }
    }
    return errorResponse('Not found', 404, origin);
  }
  
  matchPath(routePath, actualPath) {
    const routeParts = routePath.split('/').filter(Boolean);
    const actualParts = actualPath.split('/').filter(Boolean);
    if (routeParts.length !== actualParts.length) return null;
    const params = {};
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(actualParts[i]);
      } else if (routeParts[i] !== actualParts[i]) {
        return null;
      }
    }
    return { params };
  }
}

const router = new Router();

// ==================== AUTH ROUTES ====================

// POST /api/auth/register
router.post('/api/auth/register', async (request, env, _, origin) => {
  const { username, email, password, name } = await request.json();
  if (!username || !email || !password) {
    return errorResponse('Username, email, and password required', 400, origin);
  }
  if (password.length < 6) return errorResponse('Password must be at least 6 characters', 400, origin);
  
  const db = env.NEXSTREAM_DB;
  const existing = await db.prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .bind(username, email).first();
  if (existing) return errorResponse('Username or email already exists', 409, origin);
  
  const passwordHash = await hashPassword(password);
  const result = await db.prepare(
    'INSERT INTO users (username, email, password_hash, name, avatar) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, email, passwordHash, name || username, `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`)
    .run();
  
  const userId = result.meta?.last_row_id || result.lastRowId;
  const token = await signJWT({ userId, username, email }, JWT_SECRET(env));
  
  return new Response(JSON.stringify({ success: true, user: { id: userId, username, email, name: name || username } }), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800`,
      ...corsHeaders(origin)
    }
  });
});

// POST /api/auth/login
router.post('/api/auth/login', async (request, env, _, origin) => {
  const { username, password } = await request.json();
  if (!username || !password) return errorResponse('Username and password required', 400, origin);
  
  const db = env.NEXSTREAM_DB;
  const user = await db.prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .bind(username, username).first();
  if (!user) return errorResponse('Invalid credentials', 401, origin);
  
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return errorResponse('Invalid credentials', 401, origin);
  
  const token = await signJWT({ userId: user.id, username: user.username, email: user.email }, JWT_SECRET(env));
  
  return new Response(JSON.stringify({
    success: true,
    user: { id: user.id, username: user.username, email: user.email, name: user.name, avatar: user.avatar }
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800`,
      ...corsHeaders(origin)
    }
  });
});

// POST /api/auth/logout
router.post('/api/auth/logout', async (request, env, _, origin) => {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`,
      ...corsHeaders(origin)
    }
  });
});

// GET /api/auth/me
router.get('/api/auth/me', async (request, env, _, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const db = env.NEXSTREAM_DB;
  const user = await db.prepare('SELECT id, username, email, name, avatar, created_at FROM users WHERE id = ?')
    .bind(payload.userId).first();
  if (!user) return errorResponse('User not found', 404, origin);
  
  return jsonResponse({ success: true, user }, 200, origin);
});

// ==================== USER ROUTES ====================

// PUT /api/user/profile
router.put('/api/user/profile', async (request, env, _, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const { name, avatar } = await request.json();
  const db = env.NEXSTREAM_DB;
  await db.prepare('UPDATE users SET name = ?, avatar = ? WHERE id = ?')
    .bind(name || payload.username, avatar || null, payload.userId).run();
  
  return jsonResponse({ success: true }, 200, origin);
});

// GET /api/user/favorites
router.get('/api/user/favorites', async (request, env, _, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const db = env.NEXSTREAM_DB;
  const favorites = await db.prepare(
    'SELECT * FROM favorites WHERE user_id = ? ORDER BY added_at DESC'
  ).bind(payload.userId).all();
  
  return jsonResponse({ success: true, favorites: favorites.results || [] }, 200, origin);
});

// POST /api/user/favorites
router.post('/api/user/favorites', async (request, env, _, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const { mal_id, title, image, url } = await request.json();
  if (!mal_id || !title) return errorResponse('MAL ID and title required', 400, origin);
  
  const db = env.NEXSTREAM_DB;
  const existing = await db.prepare('SELECT id FROM favorites WHERE user_id = ? AND mal_id = ?')
    .bind(payload.userId, mal_id).first();
  if (existing) return errorResponse('Already in favorites', 409, origin);
  
  await db.prepare(
    'INSERT INTO favorites (user_id, mal_id, title, image, url) VALUES (?, ?, ?, ?, ?)'
  ).bind(payload.userId, mal_id, title, image || '', url || '').run();
  
  return jsonResponse({ success: true }, 201, origin);
});

// DELETE /api/user/favorites/:mal_id
router.delete('/api/user/favorites/:mal_id', async (request, env, params, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const db = env.NEXSTREAM_DB;
  await db.prepare('DELETE FROM favorites WHERE user_id = ? AND mal_id = ?')
    .bind(payload.userId, params.mal_id).run();
  
  return jsonResponse({ success: true }, 200, origin);
});

// GET /api/user/bookmarks
router.get('/api/user/bookmarks', async (request, env, _, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const db = env.NEXSTREAM_DB;
  const bookmarks = await db.prepare(
    'SELECT * FROM bookmarks WHERE user_id = ? ORDER BY added_at DESC'
  ).bind(payload.userId).all();
  
  return jsonResponse({ success: true, bookmarks: bookmarks.results || [] }, 200, origin);
});

// POST /api/user/bookmarks
router.post('/api/user/bookmarks', async (request, env, _, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const { mal_id, title, image, episode, timestamp, url } = await request.json();
  if (!mal_id || !title) return errorResponse('MAL ID and title required', 400, origin);
  
  const db = env.NEXSTREAM_DB;
  await db.prepare(
    'DELETE FROM bookmarks WHERE user_id = ? AND mal_id = ?'
  ).bind(payload.userId, mal_id).run();
  
  await db.prepare(
    'INSERT INTO bookmarks (user_id, mal_id, title, image, episode, timestamp, url) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(payload.userId, mal_id, title, image || '', episode || 1, timestamp || 0, url || '').run();
  
  return jsonResponse({ success: true }, 201, origin);
});

// DELETE /api/user/bookmarks/:mal_id
router.delete('/api/user/bookmarks/:mal_id', async (request, env, params, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const db = env.NEXSTREAM_DB;
  await db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND mal_id = ?')
    .bind(payload.userId, params.mal_id).run();
  
  return jsonResponse({ success: true }, 200, origin);
});

// GET /api/user/history
router.get('/api/user/history', async (request, env, _, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const db = env.NEXSTREAM_DB;
  const history = await db.prepare(
    'SELECT * FROM watch_history WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(payload.userId).all();
  
  return jsonResponse({ success: true, history: history.results || [] }, 200, origin);
});

// POST /api/user/history
router.post('/api/user/history', async (request, env, _, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const { mal_id, title, image, episode, progress, url } = await request.json();
  if (!mal_id || !title) return errorResponse('MAL ID and title required', 400, origin);
  
  const db = env.NEXSTREAM_DB;
  await db.prepare(
    'DELETE FROM watch_history WHERE user_id = ? AND mal_id = ?'
  ).bind(payload.userId, mal_id).run();
  
  await db.prepare(
    'INSERT INTO watch_history (user_id, mal_id, title, image, episode, progress, url) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(payload.userId, mal_id, title, image || '', episode || 1, progress || 0, url || '').run();
  
  return jsonResponse({ success: true }, 201, origin);
});

// DELETE /api/user/history/:mal_id
router.delete('/api/user/history/:mal_id', async (request, env, params, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const db = env.NEXSTREAM_DB;
  await db.prepare('DELETE FROM watch_history WHERE user_id = ? AND mal_id = ?')
    .bind(payload.userId, params.mal_id).run();
  
  return jsonResponse({ success: true }, 200, origin);
});

// ==================== COMMENT ROUTES ====================

// GET /api/comments/:anime_id
router.get('/api/comments/:anime_id', async (request, env, params, origin) => {
  const db = env.NEXSTREAM_DB;
  const animeId = params.anime_id;
  const comments = await db.prepare(
    `SELECT c.*, u.username, u.avatar FROM comments c 
     JOIN users u ON c.user_id = u.id 
     WHERE c.anime_id = ? AND c.parent_id IS NULL 
     ORDER BY c.created_at DESC`
  ).bind(animeId).all();
  
  return jsonResponse({ success: true, comments: comments.results || [] }, 200, origin);
});

// POST /api/comments/:anime_id
router.post('/api/comments/:anime_id', async (request, env, params, origin) => {
  const payload = await authMiddleware(request, env);
  if (!payload) return errorResponse('Unauthorized', 401, origin);
  
  const { content, parent_id } = await request.json();
  if (!content?.trim()) return errorResponse('Content required', 400, origin);
  
  const db = env.NEXSTREAM_DB;
  const result = await db.prepare(
    'INSERT INTO comments (user_id, anime_id, content, parent_id) VALUES (?, ?, ?, ?)'
  ).bind(payload.userId, params.anime_id, content.trim(), parent_id || null).run();
  
  return jsonResponse({ success: true, id: result.meta?.last_row_id }, 201, origin);
});

// ==================== HEALTH CHECK ====================
router.get('/api/health', async (request, env, _, origin) => {
  return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, 200, origin);
});

// ==================== MAIN HANDLER ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    
    // API routes
    if (url.pathname.startsWith('/api/')) {
      return router.handle(request, env);
    }
    
    // Serve static frontend (if using Workers as proxy)
    // For GitHub Pages frontend + Workers backend, this isn't needed
    return errorResponse('Not found. Use frontend at GitHub Pages.', 404, origin);
  }
};
