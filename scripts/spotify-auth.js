// One-time helper: gets a Spotify refresh token and prints it.
// 1. Create an app at https://developer.spotify.com/dashboard
// 2. Add redirect URI: http://127.0.0.1:8888/callback
// 3. Put SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET into .env.server
// 4. npm run spotify:auth, open the printed URL, log in

import http from 'node:http';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.server' });

const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error('❌ SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set in .env.server');
  process.exit(1);
}

const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-currently-playing user-read-recently-played user-read-playback-state';

const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
  client_id: id,
  response_type: 'code',
  redirect_uri: REDIRECT,
  scope: SCOPES,
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== '/callback') return res.writeHead(404).end();

  const code = url.searchParams.get('code');
  if (!code) return res.writeHead(400).end(url.searchParams.get('error') || 'no code');

  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
  });
  const data = await tokenRes.json();

  if (!data.refresh_token) {
    res.writeHead(500).end('failed, see terminal');
    console.error(data);
    process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('done, check terminal');
  console.log('\nAdd to .env.server:\n\nSPOTIFY_REFRESH_TOKEN=' + data.refresh_token + '\n');
  process.exit(0);
}).listen(8888, '127.0.0.1', () => {
  console.log('Open this URL:\n\n' + authUrl + '\n');
});
