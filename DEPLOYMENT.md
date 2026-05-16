# Deployment Guide

This app is a full-stack Node.js application (Express + Socket.io + MongoDB Atlas).  
Two deployment modes are supported:

| Mode | Frontend | Backend | When to use |
|------|----------|---------|-------------|
| **A — Railway only** | Railway (static via Express) | Railway | Simplest setup, one service |
| **B — Vercel + Railway** | Vercel (CDN) | Railway | Faster global static delivery |

---

## Prerequisites

### 1. MongoDB Atlas

1. Sign up at [cloud.mongodb.com](https://cloud.mongodb.com) (free M0 tier is enough).
2. Create a cluster → **Connect** → **Connect your application**.
3. Copy the connection string — it looks like:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/carpoolDB?retryWrites=true&w=majority
   ```
4. Under **Network Access**, add `0.0.0.0/0` (allow all IPs) — required for Railway's dynamic IPs.

### 2. Google OAuth (optional but recommended)
1. Go to [GCP Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an OAuth 2.0 Client ID (type: **Web application**).
3. Add your deployment URL to **Authorized JavaScript origins**:
   - `https://your-app.railway.app` and/or `https://your-app.vercel.app`
4. Copy the **Client ID**.

---

## Mode A — Railway (full-stack, recommended)

Everything — frontend + backend + WebSockets — lives in one Railway service.

### Step 1: Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and link
railway login
railway init          # creates a new project
railway up            # deploys from current directory
```

Or use the Railway dashboard: **New Project → Deploy from GitHub repo**.

### Step 2: Set Environment Variables

In the Railway dashboard → your service → **Variables**, set:

| Variable | Value |
|---|---|
| `MONGO_URI` | Your Atlas connection string |
| `JWT_SECRET` | A random 64-char hex string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `GOOGLE_CLIENT_ID` | Your Google OAuth Client ID |
| `GOOGLE_MAPS_API_KEY` | Your Google Maps API key |
| `CLIENT_ORIGIN` | `https://your-app.railway.app` (your Railway public URL) |
| `NODE_ENV` | `production` |

> **Do NOT set `PORT`** — Railway injects it automatically.

### Step 3: Verify

```
https://your-app.railway.app/health
```
Should return `{"status":"ok","db":"connected",...}`.

---

## Mode B — Vercel (frontend) + Railway (backend)

The Express backend (including Socket.io) runs on Railway.  
The static `client/` files are served from Vercel's global CDN.  
Vercel rewrites `/api/*` and `/socket.io/*` transparently to Railway —  
**no changes needed in client code**.

### Step 1: Deploy backend to Railway (same as Mode A above)

Note your Railway public URL: `https://your-app.railway.app`

Set `CLIENT_ORIGIN` in Railway variables to your **Vercel** URL:
```
CLIENT_ORIGIN=https://your-carpool.vercel.app
```

### Step 2: Update vercel.json

Replace `YOUR_RAILWAY_APP` in `vercel.json` with your actual Railway subdomain:

```json
{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://your-app.railway.app/api/:path*"
    },
    {
      "source": "/socket.io/:path*",
      "destination": "https://your-app.railway.app/socket.io/:path*"
    }
  ]
}
```

Also update the `Content-Security-Policy` header in `vercel.json` — replace both
occurrences of `YOUR_RAILWAY_APP.railway.app` with your actual domain.

### Step 3: Deploy frontend to Vercel

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy (run from repo root)
vercel --prod
```

Or connect the repo in the Vercel dashboard.  
Vercel will automatically use `outputDirectory: "client"` from `vercel.json`.

### Step 4: Verify

Visit your Vercel URL → login → everything should work including real-time location updates.

---

## Local Development

```bash
# 1. Copy env template
cp .env.example server/.env
# 2. Fill in MONGO_URI, JWT_SECRET, etc. in server/.env
# 3. Install deps
npm install
# 4. Start dev server with hot-reload
npm run dev
```

App runs at `http://localhost:8000`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `FATAL: MONGO_URI environment variable is required` | Set `MONGO_URI` in Railway variables |
| `FATAL: JWT_SECRET environment variable is required` | Set `JWT_SECRET` in Railway variables |
| `MongoDB connection attempt 1 failed: getaddrinfo ENOTFOUND` | Check Atlas Network Access — add `0.0.0.0/0` |
| CORS errors in browser console | Check `CLIENT_ORIGIN` matches your exact frontend URL (no trailing slash) |
| Socket.io disconnects on Vercel | Vercel rewrites proxy WebSockets — ensure `/socket.io/:path*` rewrite points to Railway |
| `/health` returns `{"status":"degraded"}` | DB not yet connected; check `MONGO_URI` and Atlas whitelist |
