# Local Yandex Music Proxy (Node.js)

This runs a lightweight Node.js proxy server (using `@dvxch/yandex-music` library) so your Yandex Music token stays secure.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your token file:
   - Copy `.env.server` and fill in your real token:
     ```bash
     YANDEX_MUSIC_TOKEN=your_actual_token
     ```

3. How to get Yandex Music token:
   - Go to https://music.yandex.ru (logged in)
   - Play any track
   - Open DevTools (F12) → Network tab
   - Find a request to `api.music.yandex.net`
   - Copy the value after `Authorization: OAuth `

4. **Run separately** (strongly recommended right now because of network/install issues):

   Terminal 1:
   ```bash
   npm run server
   ```
   Wait for the "Yandex Music proxy on http://localhost:4000" message.

   Terminal 2:
   ```bash
   npm run dev
   ```

   Then open http://localhost:3000

   (The `npm run dev:full` can have race conditions on startup.)

## How it works

- Frontend calls `/api/yandex`
- Vite proxy forwards it to `http://localhost:4000/api/yandex`
- Server fetches data from Yandex using your token (never sent to browser)
- Response is cached for 45 seconds

## Security notes

- Token lives only in `.env.server` (never committed)
- All Yandex calls happen server-side
- Only public track info (title, artist, cover, link) is returned

## Production

For production you can:
- Deploy the same `server.js` logic as a serverless function (Vercel, etc.)
- Or keep using a small Node service

The token must **never** be exposed in the browser.
