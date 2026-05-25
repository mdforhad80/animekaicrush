/**
 * AnimeKai Production Cloudflare Worker Backend
 * High performance routing, D1 persistence, and secure WebCrypto-based JWT Authentication.
 */

// Helper to construct secure JSON responses with CORS headers
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...headers
    }
  });
}

// Global Options handler for preflight requests
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400"
    }
  });
}

// Crypto Utils: Secure SHA-256 password hashing
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "salt-pepper-anime-kai-2024");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Basic JWT generation for Cloudflare Worker runtime
async function generateJWT(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  
  const tokenInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSha256(tokenInput, secret);
  return `${tokenInput}.${signature}`;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    
    const tokenInput = `${header}.${payload}`;
    const verifiedSignature = await hmacSha256(tokenInput, secret);
    if (signature !== verifiedSignature) return null;
    
    const decodedPayload = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (decodedPayload.exp && Date.now() / 1000 > decodedPayload.exp) return null;
    
    return decodedPayload;
  } catch (err) {
    return null;
  }
}

async function hmacSha256(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// User Extraction Middleware
async function authenticateUser(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.split(" ")[1];
  return await verifyJWT(token, env.JWT_SECRET);
}

// Primary worker entrypoint fetch handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return handleOptions();
    }

    try {
      // 1. SIGNUP ENDPOINT
      if (path === "/api/auth/signup" && method === "POST") {
        const { username, email, password, name } = await request.json();
        if (!username || !email || !password) {
          return jsonResponse({ error: "Missing required registration parameters." }, 400);
        }

        const password_hash = await hashPassword(password);
        const userId = crypto.randomUUID();

        // Check if username/email already exists
        const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?1 OR username = ?2")
          .bind(email, username)
          .first();

        if (existing) {
          return jsonResponse({ error: "User or Email already exists." }, 409);
        }

        await env.DB.prepare("INSERT INTO users (id, username, email, password_hash) VALUES (?1, ?2, ?3, ?4)")
          .bind(userId, username, email, password_hash)
          .run();

        const token = await generateJWT({ userId, username, email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, env.JWT_SECRET);
        return jsonResponse({ message: "Registration successful", token, user: { id: userId, username, email } });
      }

      // 2. LOGIN ENDPOINT
      if (path === "/api/auth/login" && method === "POST") {
        const { emailOrUsername, password } = await request.json();
        if (!emailOrUsername || !password) {
          return jsonResponse({ error: "Credentials missing." }, 400);
        }

        const password_hash = await hashPassword(password);
        const user = await env.DB.prepare("SELECT * FROM users WHERE (email = ?1 OR username = ?1) AND password_hash = ?2")
          .bind(emailOrUsername, password_hash)
          .first();

        if (!user) {
          return jsonResponse({ error: "Invalid credentials." }, 401);
        }

        const token = await generateJWT({ userId: user.id, username: user.username, email: user.email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }, env.JWT_SECRET);
        return jsonResponse({
          message: "Login successful",
          token,
          user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar }
        });
      }

      // 3. SECURE MIDDLEWARE LAYER CHECK
      const userPayload = await authenticateUser(request, env);

      // Auth validation wrapper
      const requireAuth = (handler) => {
        if (!userPayload) {
          return jsonResponse({ error: "Access Denied. Invalid or missing JWT." }, 401);
        }
        return handler(userPayload);
      };

      // 4. COMMENTS SYSTEM (READ/WRITE)
      if (path.startsWith("/api/comments") && method === "GET") {
        const malId = url.searchParams.get("mal_id");
        const episode = url.searchParams.get("episode") || "1";
        if (!malId) return jsonResponse({ error: "Missing mal_id parameter" }, 400);

        const comments = await env.DB.prepare("SELECT * FROM comments WHERE mal_id = ?1 AND episode = ?2 ORDER BY created_at DESC")
          .bind(malId, episode)
          .all();

        return jsonResponse(comments.results);
      }

      if (path.startsWith("/api/comments") && method === "POST") {
        return requireAuth(async (user) => {
          const { mal_id, episode, comment_text } = await request.json();
          if (!mal_id || !comment_text) return jsonResponse({ error: "Missing fields" }, 400);

          const userRecord = await env.DB.prepare("SELECT username, avatar FROM users WHERE id = ?1").bind(user.userId).first();

          await env.DB.prepare(
            "INSERT INTO comments (mal_id, episode, user_id, username, avatar, comment_text) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
          )
            .bind(mal_id, episode || 1, user.userId, userRecord.username, userRecord.avatar, comment_text)
            .run();

          return jsonResponse({ message: "Comment successfully posted." });
        });
      }

      // 5. PROFILE ENDPOINT
      if (path === "/api/profile" && method === "GET") {
        return requireAuth(async (user) => {
          const u = await env.DB.prepare("SELECT id, username, email, avatar, created_at FROM users WHERE id = ?1")
            .bind(user.userId)
            .first();
          return jsonResponse(u);
        });
      }

      if (path === "/api/profile/update" && method === "POST") {
        return requireAuth(async (user) => {
          const { username, avatar } = await request.json();
          if (!username) return jsonResponse({ error: "Username cannot be empty" }, 400);

          await env.DB.prepare("UPDATE users SET username = ?1, avatar = ?2 WHERE id = ?3")
            .bind(username, avatar, user.userId)
            .run();

          return jsonResponse({ message: "Profile saved." });
        });
      }

      // 6. FAVORITES & BOOKMARKS
      if (path === "/api/user/favorites" && method === "GET") {
        return requireAuth(async (user) => {
          const list = await env.DB.prepare("SELECT * FROM favorites WHERE user_id = ?1").bind(user.userId).all();
          return jsonResponse(list.results);
        });
      }

      if (path === "/api/user/favorites" && method === "POST") {
        return requireAuth(async (user) => {
          const { mal_id, title, image_url, type, score } = await request.json();
          await env.DB.prepare(
            "INSERT OR REPLACE INTO favorites (user_id, mal_id, title, image_url, type, score) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
          )
            .bind(user.userId, mal_id.toString(), title, image_url, type, score)
            .run();
          return jsonResponse({ message: "Added to Favorites" });
        });
      }

      if (path.startsWith("/api/user/favorites/delete") && method === "DELETE") {
        return requireAuth(async (user) => {
          const malId = url.searchParams.get("mal_id");
          await env.DB.prepare("DELETE FROM favorites WHERE user_id = ?1 AND mal_id = ?2")
            .bind(user.userId, malId)
            .run();
          return jsonResponse({ message: "Removed from Favorites" });
        });
      }

      // BOOKMARKS REST ENDPOINTS
      if (path === "/api/user/bookmarks" && method === "GET") {
        return requireAuth(async (user) => {
          const list = await env.DB.prepare("SELECT * FROM bookmarks WHERE user_id = ?1").bind(user.userId).all();
          return jsonResponse(list.results);
        });
      }

      if (path === "/api/user/bookmarks" && method === "POST") {
        return requireAuth(async (user) => {
          const { mal_id, title, image_url, type, score } = await request.json();
          await env.DB.prepare(
            "INSERT OR REPLACE INTO bookmarks (user_id, mal_id, title, image_url, type, score) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
          )
            .bind(user.userId, mal_id.toString(), title, image_url, type, score)
            .run();
          return jsonResponse({ message: "Bookmarked successfully." });
        });
      }

      if (path.startsWith("/api/user/bookmarks/delete") && method === "DELETE") {
        return requireAuth(async (user) => {
          const malId = url.searchParams.get("mal_id");
          await env.DB.prepare("DELETE FROM bookmarks WHERE user_id = ?1 AND mal_id = ?2")
            .bind(user.userId, malId)
            .run();
          return jsonResponse({ message: "Bookmark deleted." });
        });
      }

      // 7. CONTINUE WATCHING (WATCH HISTORY)
      if (path === "/api/user/history" && method === "GET") {
        return requireAuth(async (user) => {
          const list = await env.DB.prepare("SELECT * FROM watch_history WHERE user_id = ?1 ORDER BY updated_at DESC")
            .bind(user.userId)
            .all();
          return jsonResponse(list.results);
        });
      }

      if (path === "/api/user/history" && method === "POST") {
        return requireAuth(async (user) => {
          const { mal_id, title, image_url, episode, progress_percent } = await request.json();
          await env.DB.prepare(
            "INSERT OR REPLACE INTO watch_history (user_id, mal_id, title, image_url, episode, progress_percent, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)"
          )
            .bind(user.userId, mal_id.toString(), title, image_url, parseInt(episode), parseFloat(progress_percent))
            .run();
          return jsonResponse({ message: "History saved." });
        });
      }

      // Asset Serving integration for Cloudflare Workers SPA routing
      return await env.ASSETS.fetch(request);

    } catch (error) {
      return jsonResponse({ error: "Internal Server Error", message: error.message }, 500);
    }
  }
};
