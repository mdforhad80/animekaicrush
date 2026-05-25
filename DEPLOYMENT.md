# AnimeStream Platform - Complete Deployment Guide

## Table of Contents
1. [Project Structure](#project-structure)
2. [Prerequisites](#prerequisites)
3. [GitHub Pages Setup](#github-pages-setup)
4. [Cloudflare Pages Setup](#cloudflare-pages-setup)
5. [Cloudflare Workers Setup](#cloudflare-workers-setup)
6. [Cloudflare D1 Database Setup](#cloudflare-d1-database-setup)
7. [Security Configuration](#security-configuration)
8. [Troubleshooting](#troubleshooting)

---

## Project Structure

```
animestream-platform/
├── index.html          # Homepage with hero slider & widgets
├── anime.html          # Anime details page
├── watch.html          # Video player page
├── search.html         # Search & filter page
├── schedule.html       # Airing schedule page
├── az-list.html        # A-Z browsing page
├── profile.html        # User profile dashboard
├── worker.js           # Cloudflare Worker backend API
├── wrangler.toml       # Worker configuration
├── schema.sql          # D1 database schema
└── README.md           # This guide
```

---

## Prerequisites

- Node.js 18+ installed
- npm or yarn
- Git installed
- Cloudflare account (free tier works)
- GitHub account

---

## GitHub Pages Setup

### 1. Create Repository

```bash
# Create a new directory
mkdir animestream-platform
cd animestream-platform

# Initialize git
git init

# Add all frontend files
git add index.html anime.html watch.html search.html schedule.html az-list.html profile.html

# Commit
git commit -m "Initial commit: AnimeStream frontend"

# Create GitHub repo (via CLI or web interface)
# Then push:
git remote add origin https://github.com/YOUR_USERNAME/animestream-platform.git
git branch -M main
git push -u origin main
```

### 2. Enable GitHub Pages

1. Go to your repository on GitHub
2. Click **Settings** → **Pages** (in left sidebar)
3. Under "Source", select **Deploy from a branch**
4. Select **main** branch and **/(root)** folder
5. Click **Save**
6. Wait 1-2 minutes for deployment
7. Your site will be at: `https://YOUR_USERNAME.github.io/animestream-platform/`

### 3. Updating Your Site

```bash
# Make changes to files
git add .
git commit -m "Update: description of changes"
git push origin main
# GitHub Pages will auto-deploy within 1-2 minutes
```

---

## Cloudflare Pages Setup

### 1. Connect GitHub Repository

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Pages** in the left sidebar
3. Click **Create a project** → **Connect to Git**
4. Select your GitHub account and the `animestream-platform` repository
5. Click **Begin setup**

### 2. Build Settings

Configure the following:

| Setting | Value |
|---------|-------|
| Project name | `animestream-platform` |
| Production branch | `main` |
| Build command | (leave empty - static site) |
| Build output directory | `/` (root) |

Click **Save and Deploy**

### 3. Environment Variables

Add these in **Pages** → **Your Project** → **Settings** → **Environment variables**:

| Variable | Value | Environment |
|----------|-------|-------------|
| `BACKEND_URL` | `https://your-worker.your-subdomain.workers.dev` | Production |

### 4. Custom Domain (Optional)

1. Go to **Pages** → **Your Project** → **Custom domains**
2. Click **Set up a custom domain**
3. Enter your domain (e.g., `animestream.example.com`)
4. Follow DNS instructions:
   - Add a CNAME record pointing to your Pages domain
   - Or use Cloudflare's quick setup if domain is on Cloudflare

### 5. DNS Setup

If using Cloudflare DNS:

```
Type: CNAME
Name: animestream (or @ for root)
Target: your-project.pages.dev
TTL: Auto
Proxy: Enabled (orange cloud)
```

---

## Cloudflare Workers Setup

### 1. Install Wrangler CLI

```bash
# Install globally
npm install -g wrangler

# Or use npx (no global install needed)
npx wrangler --version
```

### 2. Authenticate

```bash
wrangler login
# This opens a browser window to authorize Wrangler
```

### 3. Create Worker Project

```bash
# Create worker directory
mkdir animestream-worker
cd animestream-worker

# Initialize Wrangler
wrangler init --yes

# Copy worker.js and wrangler.toml from this project
# Edit wrangler.toml with your actual database IDs
```

### 4. Update wrangler.toml

```toml
name = "animestream-platform"
main = "worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "animestream-db"
database_id = "YOUR-DATABASE-ID-HERE"

[[kv_namespaces]]
binding = "CACHE"
id = "YOUR-KV-NAMESPACE-ID-HERE"

[vars]
JWT_SECRET = "your-super-secret-jwt-key-change-this-in-production"
API_RATE_LIMIT = "100"
```

### 5. Deploy Worker

```bash
# Development mode
wrangler dev

# Deploy to production
wrangler deploy

# Deploy with environment
wrangler deploy --env production
```

### 6. API Routing

The Worker handles these routes:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | User registration |
| POST | `/api/auth/login` | User login |
| GET | `/api/auth/me` | Get current user |
| GET | `/api/favorites` | List favorites |
| POST | `/api/favorites` | Add favorite |
| DELETE | `/api/favorites/:id` | Remove favorite |
| GET | `/api/bookmarks` | List bookmarks |
| POST | `/api/bookmarks` | Add bookmark |
| DELETE | `/api/bookmarks/:id` | Remove bookmark |
| GET | `/api/history` | Watch history |
| POST | `/api/history` | Add history entry |
| DELETE | `/api/history/:id` | Remove history |
| GET | `/api/comments?anime_id=` | Get comments |
| POST | `/api/comments` | Post comment |
| POST | `/api/comments/:id/like` | Like comment |
| PUT | `/api/profile` | Update profile |
| GET | `/api/stats` | User stats |
| GET | `/api/health` | Health check |

### 7. CORS Configuration

The Worker automatically handles CORS with these headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With
```

For production, update `CORS_HEADERS` in `worker.js` to restrict origins:
```javascript
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://your-domain.com',
  // ...
};
```

---

## Cloudflare D1 Database Setup

### 1. Create Database

```bash
# Create D1 database
wrangler d1 create animestream-db

# Output will show:
# [[d1_databases]]
# binding = "DB"
# database_name = "animestream-db"
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 2. Create Production Database (Optional)

```bash
wrangler d1 create animestream-db-prod
```

### 3. Initialize Schema

```bash
# Execute schema on local dev database
wrangler d1 execute animestream-db --file=./schema.sql

# Execute on production database
wrangler d1 execute animestream-db --file=./schema.sql --remote
```

### 4. Verify Tables

```bash
# List tables
wrangler d1 execute animestream-db --command="SELECT name FROM sqlite_master WHERE type='table';"

# Check indexes
wrangler d1 execute animestream-db --command="SELECT name FROM sqlite_master WHERE type='index';"
```

### 5. Local Development with D1

```bash
# Start local dev server with D1 binding
wrangler dev --local --persist

# D1 data will be stored in .wrangler/state/
```

---

## Security Configuration

### 1. JWT Secret

**IMPORTANT**: Change the default JWT secret before production!

Generate a secure secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Update in `wrangler.toml`:
```toml
[vars]
JWT_SECRET = "your-generated-secret-here"
```

Or use Wrangler secret (more secure):
```bash
wrangler secret put JWT_SECRET
# Enter your secret when prompted
```

### 2. Password Hashing

The Worker uses PBKDF2 with:
- SHA-256 hash algorithm
- 100,000 iterations
- 16-byte random salt
- 256-bit derived key

This is implemented natively using `crypto.subtle` - no external dependencies.

### 3. Rate Limiting

Default: 100 requests per minute per IP

Adjust in `wrangler.toml`:
```toml
[vars]
API_RATE_LIMIT = "100"
```

### 4. HTTPS Enforcement

Cloudflare Workers and Pages automatically serve over HTTPS. Ensure:
- "Always Use HTTPS" is enabled in Cloudflare Dashboard
- HSTS headers are configured (in Cloudflare Dashboard → SSL/TLS → Edge Certificates)

### 5. Secure Headers (Optional)

Add to `worker.js` response headers:
```javascript
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src * data:; frame-src *; connect-src *;"
};
```

---

## Troubleshooting

### Frontend Issues

| Issue | Solution |
|-------|----------|
| Blank page / widgets not loading | Check browser console for CORS errors. Ensure backend URL is set correctly in profile settings |
| Images not loading | Jikan API rate limit (3 req/sec). Wait a moment and refresh |
| Search not working | Check if Jikan API is accessible: `https://api.jikan.moe/v4` |
| Auth modal not opening | Check if `backendUrl` is configured in localStorage |

### Backend Issues

| Issue | Solution |
|-------|----------|
| Worker returns 500 | Check Wrangler logs: `wrangler tail` |
| Database errors | Verify D1 binding in `wrangler.toml` matches actual database ID |
| CORS errors | Ensure `BACKEND_URL` in frontend matches Worker URL exactly |
| JWT errors | Verify `JWT_SECRET` is set and consistent |

### Deployment Issues

| Issue | Solution |
|-------|----------|
| GitHub Pages 404 | Ensure `index.html` exists at repository root |
| Cloudflare Pages build fails | Set build command to empty, output directory to `/` |
| Worker not deploying | Check `wrangler.toml` syntax and account permissions |
| D1 migration fails | Ensure schema.sql uses D1-compatible SQLite syntax |

### Common Commands

```bash
# View Worker logs
wrangler tail

# List D1 databases
wrangler d1 list

# Execute SQL directly
wrangler d1 execute animestream-db --command="SELECT * FROM users LIMIT 5;"

# Delete and recreate database (CAUTION: data loss)
wrangler d1 delete animestream-db
wrangler d1 create animestream-db

# Clear KV cache
wrangler kv namespace list
wrangler kv bulk delete --namespace-id=YOUR_ID ./keys-to-delete.json
```

---

## Environment Variables Reference

### Frontend (localStorage)
| Key | Description | Default |
|-----|-------------|---------|
| `backendUrl` | Cloudflare Worker URL | `""` |
| `authToken` | JWT auth token | `""` |
| `language` | UI language (en/jp/bn) | `"en"` |

### Worker (wrangler.toml / Secrets)
| Variable | Description | Required |
|----------|-------------|----------|
| `JWT_SECRET` | Secret for JWT signing | Yes |
| `API_RATE_LIMIT` | Requests per minute per IP | No (default: 100) |

### D1 Bindings
| Binding | Description |
|---------|-------------|
| `DB` | Main database for users, favorites, bookmarks, history, comments |
| `CACHE` | Optional KV namespace for caching |

---

## Performance Tips

1. **Enable Cloudflare Caching**: Set Cache-Control headers for static assets
2. **Use KV for API Caching**: Cache Jikan API responses in Workers KV
3. **Image Optimization**: Consider using Cloudflare Images for poster optimization
4. **Lazy Loading**: Already implemented for images and sections
5. **Minimize API Calls**: The frontend caches API responses for 5 minutes

---

## Support

For issues or questions:
- Jikan API Docs: https://docs.api.jikan.moe/
- Cloudflare Workers Docs: https://developers.cloudflare.com/workers/
- Cloudflare D1 Docs: https://developers.cloudflare.com/d1/

---

**Disclaimer**: This site does not store any files on its server. All contents are provided by non-affiliated third parties.
