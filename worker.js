// Cloudflare Worker Backend for AnimeStream Platform
// Features: JWT Auth, D1 Database, Comments API, CORS

const encoder = new TextEncoder();

async function importKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function base64UrlEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str) {
  const padding = '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + padding;
  const raw = atob(base64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function signJWT(payload, secret, expiresIn = '7d') {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  let exp = now + 604800;
  if (typeof expiresIn === 'string') {
    const m = expiresIn.match(/^(\d+)([smhd])$/);
    if (m) {
      const v = parseInt(m[1]);
      const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
      exp = now + v * mult;
    }
  }
  const fullPayload = { ...payload, iat: now, exp };
  const h = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const p = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const sig = await crypto.subtle.sign('HMAC', await importKey(secret), encoder.encode(h + '.' + p));
  return h + '.' + p + '.' + base64UrlEncode(sig);
}

async function verifyJWT(token, secret) {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const valid = await crypto.subtle.verify('HMAC', await importKey(secret), base64UrlDecode(s), encoder.encode(h + '.' + p));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

async function hashPassword(password, salt) {
  const data = encoder.encode(password + salt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hash);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function authMiddleware(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: 'Missing token', status: 401 };
  }
  const token = authHeader.slice(7);
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return { error: 'Invalid or expired token', status: 401 };
  return { user: payload };
}

async function dbQuery(db, sql, params) {
  const stmt = db.prepare(sql);
  return stmt.bind(...params).all();
}

async function dbRun(db, sql, params) {
  const stmt = db.prepare(sql);
  return stmt.bind(...params).run();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const origin = request.headers.get('Origin') || '*';

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const headers = corsHeaders(origin);

    try {
      if (path === '/api/health' && method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, 200, headers);
      }

      if (path === '/api/auth/register' && method === 'POST') {
        const { name, username, email, password } = await request.json();
        if (!name || !username || !email || !password) {
          return jsonResponse({ error: 'All fields are required' }, 400, headers);
        }
        if (password.length < 6) {
          return jsonResponse({ error: 'Password must be at least 6 characters' }, 400, headers);
        }
        const existing = await dbQuery(env.DB, 'SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
        if (existing.results.length > 0) {
          return jsonResponse({ error: 'User already exists' }, 409, headers);
        }
        const hashed = await hashPassword(password, env.JWT_SECRET);
        await dbRun(env.DB, 'INSERT INTO users (name, username, email, password_hash, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [name, username, email, hashed, '', Date.now()]);
        return jsonResponse({ success: true, message: 'User registered' }, 201, headers);
      }

      if (path === '/api/auth/login' && method === 'POST') {
        const { email, password } = await request.json();
        if (!email || !password) {
          return jsonResponse({ error: 'Email and password required' }, 400, headers);
        }
        const users = await dbQuery(env.DB, 'SELECT * FROM users WHERE email = ?', [email]);
        if (users.results.length === 0) {
          return jsonResponse({ error: 'Invalid credentials' }, 401, headers);
        }
        const user = users.results[0];
        const hashed = await hashPassword(password, env.JWT_SECRET);
        if (hashed !== user.password_hash) {
          return jsonResponse({ error: 'Invalid credentials' }, 401, headers);
        }
        const token = await signJWT({ sub: user.id, email: user.email, username: user.username, name: user.name }, env.JWT_SECRET, '7d');
        return jsonResponse({ success: true, token, user: { id: user.id, name: user.name, username: user.username, email: user.email, avatar: user.avatar } }, 200, headers);
      }

      if (path === '/api/auth/me' && method === 'GET') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const users = await dbQuery(env.DB, 'SELECT id, name, username, email, avatar, created_at FROM users WHERE id = ?', [auth.user.sub]);
        if (users.results.length === 0) return jsonResponse({ error: 'User not found' }, 404, headers);
        return jsonResponse({ user: users.results[0] }, 200, headers);
      }

      if (path === '/api/auth/profile' && method === 'PUT') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const { name, avatar } = await request.json();
        await dbRun(env.DB, 'UPDATE users SET name = ?, avatar = ? WHERE id = ?', [name || '', avatar || '', auth.user.sub]);
        return jsonResponse({ success: true, message: 'Profile updated' }, 200, headers);
      }

      if (path === '/api/comments' && method === 'GET') {
        const animeId = url.searchParams.get('anime_id');
        if (!animeId) return jsonResponse({ error: 'anime_id required' }, 400, headers);
        const comments = await dbQuery(env.DB, 'SELECT c.*, u.name as user_name, u.avatar as user_avatar FROM comments c JOIN users u ON c.user_id = u.id WHERE c.anime_id = ? ORDER BY c.created_at DESC LIMIT 50', [animeId]);
        return jsonResponse({ comments: comments.results }, 200, headers);
      }

      if (path === '/api/comments' && method === 'POST') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const { anime_id, text, parent_id } = await request.json();
        if (!anime_id || !text) return jsonResponse({ error: 'anime_id and text required' }, 400, headers);
        await dbRun(env.DB, 'INSERT INTO comments (anime_id, user_id, text, parent_id, created_at) VALUES (?, ?, ?, ?, ?)',
          [anime_id, auth.user.sub, text, parent_id || null, Date.now()]);
        return jsonResponse({ success: true, message: 'Comment posted' }, 201, headers);
      }

      if (path === '/api/comments/like' && method === 'POST') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const { comment_id } = await request.json();
        if (!comment_id) return jsonResponse({ error: 'comment_id required' }, 400, headers);
        const existing = await dbQuery(env.DB, 'SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?', [comment_id, auth.user.sub]);
        if (existing.results.length > 0) {
          await dbRun(env.DB, 'DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?', [comment_id, auth.user.sub]);
          await dbRun(env.DB, 'UPDATE comments SET likes = likes - 1 WHERE id = ?', [comment_id]);
          return jsonResponse({ success: true, liked: false }, 200, headers);
        }
        await dbRun(env.DB, 'INSERT INTO comment_likes (comment_id, user_id, created_at) VALUES (?, ?, ?)', [comment_id, auth.user.sub, Date.now()]);
        await dbRun(env.DB, 'UPDATE comments SET likes = likes + 1 WHERE id = ?', [comment_id]);
        return jsonResponse({ success: true, liked: true }, 200, headers);
      }

      if (path === '/api/favorites' && method === 'GET') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const favs = await dbQuery(env.DB, 'SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC', [auth.user.sub]);
        return jsonResponse({ favorites: favs.results }, 200, headers);
      }

      if (path === '/api/favorites' && method === 'POST') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const { anime_id, title, image } = await request.json();
        if (!anime_id) return jsonResponse({ error: 'anime_id required' }, 400, headers);
        const existing = await dbQuery(env.DB, 'SELECT id FROM favorites WHERE user_id = ? AND anime_id = ?', [auth.user.sub, anime_id]);
        if (existing.results.length > 0) {
          await dbRun(env.DB, 'DELETE FROM favorites WHERE user_id = ? AND anime_id = ?', [auth.user.sub, anime_id]);
          return jsonResponse({ success: true, favorited: false }, 200, headers);
        }
        await dbRun(env.DB, 'INSERT INTO favorites (user_id, anime_id, title, image, created_at) VALUES (?, ?, ?, ?, ?)',
          [auth.user.sub, anime_id, title || '', image || '', Date.now()]);
        return jsonResponse({ success: true, favorited: true }, 201, headers);
      }

      if (path === '/api/bookmarks' && method === 'GET') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const marks = await dbQuery(env.DB, 'SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC', [auth.user.sub]);
        return jsonResponse({ bookmarks: marks.results }, 200, headers);
      }

      if (path === '/api/bookmarks' && method === 'POST') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const { anime_id, title, image } = await request.json();
        if (!anime_id) return jsonResponse({ error: 'anime_id required' }, 400, headers);
        const existing = await dbQuery(env.DB, 'SELECT id FROM bookmarks WHERE user_id = ? AND anime_id = ?', [auth.user.sub, anime_id]);
        if (existing.results.length > 0) {
          await dbRun(env.DB, 'DELETE FROM bookmarks WHERE user_id = ? AND anime_id = ?', [auth.user.sub, anime_id]);
          return jsonResponse({ success: true, bookmarked: false }, 200, headers);
        }
        await dbRun(env.DB, 'INSERT INTO bookmarks (user_id, anime_id, title, image, created_at) VALUES (?, ?, ?, ?, ?)',
          [auth.user.sub, anime_id, title || '', image || '', Date.now()]);
        return jsonResponse({ success: true, bookmarked: true }, 201, headers);
      }

      if (path === '/api/history' && method === 'GET') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const hist = await dbQuery(env.DB, 'SELECT * FROM watch_history WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', [auth.user.sub]);
        return jsonResponse({ history: hist.results }, 200, headers);
      }

      if (path === '/api/history' && method === 'POST') {
        const auth = await authMiddleware(request, env);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status, headers);
        const { anime_id, title, image, episode } = await request.json();
        if (!anime_id) return jsonResponse({ error: 'anime_id required' }, 400, headers);
        const existing = await dbQuery(env.DB, 'SELECT id FROM watch_history WHERE user_id = ? AND anime_id = ?', [auth.user.sub, anime_id]);
        if (existing.results.length > 0) {
          await dbRun(env.DB, 'UPDATE watch_history SET episode = ?, updated_at = ? WHERE user_id = ? AND anime_id = ?',
            [episode || 1, Date.now(), auth.user.sub, anime_id]);
        } else {
          await dbRun(env.DB, 'INSERT INTO watch_history (user_id, anime_id, title, image, episode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [auth.user.sub, anime_id, title || '', image || '', episode || 1, Date.now(), Date.now()]);
        }
        return jsonResponse({ success: true }, 200, headers);
      }

      return jsonResponse({ error: 'Not found' }, 404, headers);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500, headers);
    }
  }
};
