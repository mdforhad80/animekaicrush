// AnimeStream Platform - Cloudflare Worker Backend
// Production-ready API with JWT auth, D1 database, rate limiting

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

// ==================== CRYPTO UTILITIES ====================

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const saltStr = btoa(String.fromCharCode(...salt));
  const hashStr = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return `${saltStr}.${hashStr}`;
}

async function verifyPassword(password, stored) {
  const [saltStr, hashStr] = stored.split('.');
  const salt = Uint8Array.from(atob(saltStr), c => c.charCodeAt(0));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const newHash = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return newHash === hashStr;
}

async function signJWT(payload, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign('HMAC', key, data);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const [headerB64, payloadB64, signatureB64] = parts;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sig = Uint8Array.from(atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify('HMAC', key, sig, data);
  if (!valid) throw new Error('Invalid signature');
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}

// ==================== RESPONSE HELPERS ====================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

// ==================== RATE LIMITING ====================

const rateLimitMap = new Map();

function checkRateLimit(clientIP, limit = 100, windowMs = 60000) {
  const now = Date.now();
  const key = `${clientIP}`;
  const record = rateLimitMap.get(key) || { count: 0, resetTime: now + windowMs };

  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + windowMs;
  }

  record.count++;
  rateLimitMap.set(key, record);

  if (record.count > limit) {
    return false;
  }
  return true;
}

// ==================== AUTH MIDDLEWARE ====================

async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    const user = await env.DB.prepare('SELECT id, username, email, name, avatar FROM users WHERE id = ?')
      .bind(payload.userId).first();
    return user;
  } catch (e) {
    return null;
  }
}

// ==================== REQUEST HANDLER ====================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Rate limiting
    if (!checkRateLimit(clientIP, parseInt(env.API_RATE_LIMIT || '100'))) {
      return errorResponse('Rate limit exceeded. Please try again later.', 429);
    }

    try {
      // ==================== AUTH ROUTES ====================

      if (path === '/api/auth/register' && request.method === 'POST') {
        const body = await request.json();
        const { username, email, password, name } = body;

        if (!username || !email || !password) {
          return errorResponse('Username, email, and password are required');
        }
        if (password.length < 6) {
          return errorResponse('Password must be at least 6 characters');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return errorResponse('Invalid email format');
        }

        const existing = await env.DB.prepare(
          'SELECT id FROM users WHERE username = ? OR email = ?'
        ).bind(username, email).first();

        if (existing) {
          return errorResponse('Username or email already exists', 409);
        }

        const passwordHash = await hashPassword(password);
        const result = await env.DB.prepare(
          'INSERT INTO users (username, email, password_hash, name) VALUES (?, ?, ?, ?)'
        ).bind(username, email, passwordHash, name || username).run();

        const userId = result.meta.last_row_id;
        const token = await signJWT({ userId, username, exp: Math.floor(Date.now() / 1000) + 604800 }, env.JWT_SECRET);

        return jsonResponse({
          success: true,
          token,
          user: { id: userId, username, email, name: name || username }
        });
      }

      if (path === '/api/auth/login' && request.method === 'POST') {
        const body = await request.json();
        const { email, password, remember } = body;

        if (!email || !password) {
          return errorResponse('Email and password are required');
        }

        const user = await env.DB.prepare(
          'SELECT id, username, email, password_hash, name, avatar FROM users WHERE email = ? OR username = ?'
        ).bind(email, email).first();

        if (!user) {
          return errorResponse('Invalid credentials', 401);
        }

        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
          return errorResponse('Invalid credentials', 401);
        }

        const exp = remember ? Math.floor(Date.now() / 1000) + 2592000 : Math.floor(Date.now() / 1000) + 604800;
        const token = await signJWT({ userId: user.id, username: user.username, exp }, env.JWT_SECRET);

        return jsonResponse({
          success: true,
          token,
          user: { id: user.id, username: user.username, email: user.email, name: user.name, avatar: user.avatar }
        });
      }

      if (path === '/api/auth/me' && request.method === 'GET') {
        const user = await authenticate(request, env);
        if (!user) {
          return errorResponse('Unauthorized', 401);
        }
        return jsonResponse({ success: true, user });
      }

      // ==================== FAVORITES ROUTES ====================

      if (path === '/api/favorites' && request.method === 'GET') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const favorites = await env.DB.prepare(
          'SELECT * FROM favorites WHERE user_id = ? ORDER BY created_at DESC'
        ).bind(user.id).all();

        return jsonResponse({ success: true, favorites: favorites.results || [] });
      }

      if (path === '/api/favorites' && request.method === 'POST') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const body = await request.json();
        const { anime_id, anime_title, anime_image, anime_type } = body;

        if (!anime_id || !anime_title) {
          return errorResponse('Anime ID and title are required');
        }

        try {
          await env.DB.prepare(
            'INSERT INTO favorites (user_id, anime_id, anime_title, anime_image, anime_type) VALUES (?, ?, ?, ?, ?)'
          ).bind(user.id, anime_id, anime_title, anime_image || '', anime_type || '').run();

          return jsonResponse({ success: true, message: 'Added to favorites' });
        } catch (e) {
          if (e.message && e.message.includes('UNIQUE constraint failed')) {
            return errorResponse('Already in favorites', 409);
          }
          throw e;
        }
      }

      if (path.startsWith('/api/favorites/') && request.method === 'DELETE') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const animeId = path.split('/')[3];
        await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND anime_id = ?')
          .bind(user.id, animeId).run();

        return jsonResponse({ success: true, message: 'Removed from favorites' });
      }

      // ==================== BOOKMARKS ROUTES ====================

      if (path === '/api/bookmarks' && request.method === 'GET') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const bookmarks = await env.DB.prepare(
          'SELECT * FROM bookmarks WHERE user_id = ? ORDER BY updated_at DESC'
        ).bind(user.id).all();

        return jsonResponse({ success: true, bookmarks: bookmarks.results || [] });
      }

      if (path === '/api/bookmarks' && request.method === 'POST') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const body = await request.json();
        const { anime_id, anime_title, anime_image, episode_number } = body;

        if (!anime_id || !anime_title) {
          return errorResponse('Anime ID and title are required');
        }

        try {
          await env.DB.prepare(
            'INSERT INTO bookmarks (user_id, anime_id, anime_title, anime_image, episode_number) VALUES (?, ?, ?, ?, ?)'
          ).bind(user.id, anime_id, anime_title, anime_image || '', episode_number || 1).run();

          return jsonResponse({ success: true, message: 'Bookmarked' });
        } catch (e) {
          if (e.message && e.message.includes('UNIQUE constraint failed')) {
            await env.DB.prepare(
              'UPDATE bookmarks SET episode_number = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND anime_id = ?'
            ).bind(episode_number || 1, user.id, anime_id).run();
            return jsonResponse({ success: true, message: 'Bookmark updated' });
          }
          throw e;
        }
      }

      if (path.startsWith('/api/bookmarks/') && request.method === 'DELETE') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const animeId = path.split('/')[3];
        await env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ? AND anime_id = ?')
          .bind(user.id, animeId).run();

        return jsonResponse({ success: true, message: 'Bookmark removed' });
      }

      // ==================== WATCH HISTORY ROUTES ====================

      if (path === '/api/history' && request.method === 'GET') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const history = await env.DB.prepare(
          'SELECT * FROM watch_history WHERE user_id = ? ORDER BY updated_at DESC'
        ).bind(user.id).all();

        return jsonResponse({ success: true, history: history.results || [] });
      }

      if (path === '/api/history' && request.method === 'POST') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const body = await request.json();
        const { anime_id, anime_title, anime_image, episode_number, progress_seconds, total_seconds } = body;

        if (!anime_id || !anime_title) {
          return errorResponse('Anime ID and title are required');
        }

        try {
          await env.DB.prepare(
            'INSERT INTO watch_history (user_id, anime_id, anime_title, anime_image, episode_number, progress_seconds, total_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(user.id, anime_id, anime_title, anime_image || '', episode_number || 1, progress_seconds || 0, total_seconds || 0).run();

          return jsonResponse({ success: true, message: 'History recorded' });
        } catch (e) {
          if (e.message && e.message.includes('UNIQUE constraint failed')) {
            await env.DB.prepare(
              'UPDATE watch_history SET episode_number = ?, progress_seconds = ?, total_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND anime_id = ?'
            ).bind(episode_number || 1, progress_seconds || 0, total_seconds || 0, user.id, anime_id).run();
            return jsonResponse({ success: true, message: 'History updated' });
          }
          throw e;
        }
      }

      if (path.startsWith('/api/history/') && request.method === 'DELETE') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const animeId = path.split('/')[3];
        await env.DB.prepare('DELETE FROM watch_history WHERE user_id = ? AND anime_id = ?')
          .bind(user.id, animeId).run();

        return jsonResponse({ success: true, message: 'History removed' });
      }

      // ==================== COMMENTS ROUTES ====================

      if (path === '/api/comments' && request.method === 'GET') {
        const animeId = url.searchParams.get('anime_id');
        if (!animeId) return errorResponse('Anime ID is required');

        const comments = await env.DB.prepare(
          `SELECT c.*, u.username, u.avatar, u.name 
           FROM comments c 
           JOIN users u ON c.user_id = u.id 
           WHERE c.anime_id = ? AND c.parent_id IS NULL 
           ORDER BY c.created_at DESC`
        ).bind(animeId).all();

        return jsonResponse({ success: true, comments: comments.results || [] });
      }

      if (path === '/api/comments' && request.method === 'POST') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const body = await request.json();
        const { anime_id, content, parent_id } = body;

        if (!anime_id || !content || content.trim().length === 0) {
          return errorResponse('Anime ID and content are required');
        }
        if (content.length > 2000) {
          return errorResponse('Comment too long (max 2000 characters)');
        }

        const result = await env.DB.prepare(
          'INSERT INTO comments (user_id, anime_id, content, parent_id) VALUES (?, ?, ?, ?)'
        ).bind(user.id, anime_id, content.trim(), parent_id || null).run();

        return jsonResponse({
          success: true,
          comment: {
            id: result.meta.last_row_id,
            user_id: user.id,
            username: user.username,
            name: user.name,
            avatar: user.avatar,
            anime_id,
            content: content.trim(),
            parent_id: parent_id || null,
            likes: 0,
            created_at: new Date().toISOString()
          }
        });
      }

      if (path.startsWith('/api/comments/') && path.endsWith('/like') && request.method === 'POST') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const commentId = path.split('/')[3];

        try {
          await env.DB.prepare(
            'INSERT INTO comment_likes (user_id, comment_id) VALUES (?, ?)'
          ).bind(user.id, commentId).run();

          await env.DB.prepare(
            'UPDATE comments SET likes = likes + 1 WHERE id = ?'
          ).bind(commentId).run();

          return jsonResponse({ success: true, message: 'Liked' });
        } catch (e) {
          if (e.message && e.message.includes('UNIQUE constraint failed')) {
            return errorResponse('Already liked', 409);
          }
          throw e;
        }
      }

      // ==================== PROFILE ROUTES ====================

      if (path === '/api/profile' && request.method === 'PUT') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const body = await request.json();
        const { name, avatar } = body;

        await env.DB.prepare(
          'UPDATE users SET name = ?, avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(name || user.name, avatar || user.avatar, user.id).run();

        return jsonResponse({ success: true, message: 'Profile updated' });
      }

      if (path === '/api/stats' && request.method === 'GET') {
        const user = await authenticate(request, env);
        if (!user) return errorResponse('Unauthorized', 401);

        const favCount = await env.DB.prepare('SELECT COUNT(*) as count FROM favorites WHERE user_id = ?').bind(user.id).first();
        const bmCount = await env.DB.prepare('SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ?').bind(user.id).first();
        const histCount = await env.DB.prepare('SELECT COUNT(*) as count FROM watch_history WHERE user_id = ?').bind(user.id).first();

        return jsonResponse({
          success: true,
          stats: {
            favorites: favCount?.count || 0,
            bookmarks: bmCount?.count || 0,
            history: histCount?.count || 0
          }
        });
      }

      // ==================== HEALTH CHECK ====================

      if (path === '/api/health') {
        return jsonResponse({ success: true, status: 'ok', timestamp: new Date().toISOString() });
      }

      return errorResponse('Not found', 404);

    } catch (error) {
      console.error('Worker error:', error);
      return errorResponse(error.message || 'Internal server error', 500);
    }
  }
};
