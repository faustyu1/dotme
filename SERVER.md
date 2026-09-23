# Local Spotify Proxy (Node.js)

Small Express server that calls the official Spotify Web API so your credentials stay server-side.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a Spotify app at https://developer.spotify.com/dashboard
   - Redirect URI: `http://127.0.0.1:8888/callback`
   - API: Web API

3. Create `.env.server`:
   ```bash
   SPOTIFY_CLIENT_ID=your_client_id
   SPOTIFY_CLIENT_SECRET=your_client_secret
   VIEWS_SECRET=any_long_random_string   # e.g. openssl rand -base64 32
   ```

4. Get a refresh token:
   ```bash
   npm run spotify:auth
   ```
   Open the printed URL, log in, then add the printed `SPOTIFY_REFRESH_TOKEN=...` line to `.env.server`.

5. Run:
   ```bash
   npm run dev:full
   ```
   Open http://localhost:3000

## How it works

- Frontend calls `/api/spotify`
- Vite proxy forwards it to `http://localhost:4000/api/spotify`
- `api/spotify.js` exchanges the refresh token for an access token and calls
  `/v1/me/player` (track + device) and `/v1/me/player/recently-played`
- Scopes: `user-read-currently-playing user-read-recently-played user-read-playback-state`
- Response is cached in memory for 3 seconds (no CDN caching); the page polls every 5 seconds

## View counter

`api/views.js` counts at most one view per IP per day (UTC). A view counts only if the browser
got an HMAC-signed, IP-bound challenge from `GET /api/views`, stayed on the page for 3+ seconds,
solved a 16-bit SHA-256 proof of work and posts from this site's origin with a non-bot user agent.
Only salted hashes of IPs are stored, and they're pruned after two days.

- Production: Postgres from the `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`,
  `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` variables. The `page_views` table is created on first request.
- Local dev (no `POSTGRES_HOST`): stored in `.data/views.json`.

## Production (Vercel)

`api/spotify.js` and `api/views.js` are deployed as serverless functions. Set the three
`SPOTIFY_*` variables and `VIEWS_SECRET` in the Vercel project environment.
