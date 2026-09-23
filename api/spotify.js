// Spotify now-playing via the official Spotify Web API.
// Env: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
// (refresh token needs scopes: user-read-currently-playing user-read-recently-played)

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const CACHE_MS = 10000;

let accessToken = null;
let accessTokenExp = 0;
let cache = null;

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExp - 30000) return accessToken;

  const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret, SPOTIFY_REFRESH_TOKEN: refresh } = process.env;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  accessToken = data.access_token;
  accessTokenExp = Date.now() + data.expires_in * 1000;
  return accessToken;
}

async function spotify(path) {
  const token = await getAccessToken();
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

function toTrack(item, isPlaying = false) {
  if (!item) return null;
  return {
    id: item.id,
    title: item.name,
    artist: item.artists ? item.artists.map((a) => a.name).join(', ') : item.show?.name || '',
    url: item.external_urls?.spotify,
    art: (item.album?.images || item.images || [])[0]?.url,
    isPlaying,
  };
}

// Spotify's recently-played lags by several minutes and skips some plays,
// so we also remember track changes we observe ourselves (per warm instance).
const HISTORY_SIZE = 3;
let observed = [];
let lastNp = null;

function observe(np) {
  if (lastNp && lastNp.id !== np?.id) {
    observed = [{ track: { ...lastNp, isPlaying: false }, playedAt: Date.now() }, ...observed].slice(0, 20);
  }
  if (np) lastNp = np;
}

async function load() {
  const [current, recent] = await Promise.all([
    spotify('/me/player/currently-playing?additional_types=track,episode'),
    spotify('/me/player/recently-played?limit=20'),
  ]);

  const played = (recent?.items || []).map((i) => ({ track: toTrack(i.track), playedAt: Date.parse(i.played_at) }));
  let nowPlaying = current?.item
    ? { ...toTrack(current.item, Boolean(current.is_playing)), progressMs: current.progress_ms, durationMs: current.item.duration_ms }
    : null;
  if (!nowPlaying && played.length) nowPlaying = played[0].track;

  observe(nowPlaying);

  const seen = new Set([nowPlaying?.id]);
  const history = [...observed, ...played]
    .sort((a, b) => b.playedAt - a.playedAt)
    .map((p) => p.track)
    .filter((t) => t?.id && !seen.has(t.id) && seen.add(t.id))
    .slice(0, HISTORY_SIZE);

  // ts lets the client extrapolate progress through our cache and the CDN cache.
  return { nowPlaying, recent: history, ts: Date.now() };
}

export default async function handler(req, res) {
  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN } = process.env;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'Spotify credentials not configured' });
  }

  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');

  if (cache && Date.now() - cache.ts < CACHE_MS) return res.status(200).json(cache.data);

  try {
    const data = await load();
    cache = { ts: Date.now(), data };
    return res.status(200).json(data);
  } catch (err) {
    console.error('[spotify]', err.message);
    if (cache) return res.status(200).json(cache.data);
    return res.status(502).json({ error: 'Spotify request failed' });
  }
}
