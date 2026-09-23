// Page view counter with anti-inflation checks.
//
// GET  /api/views  -> { count, challenge }   challenge is HMAC-signed and bound to the caller's IP
// POST /api/views  { challenge, solution }  -> { count, counted }
//
// A view is counted only when all of these hold:
//   - request comes from a browser on this site (Origin / Sec-Fetch-Site, no bot user agent)
//   - the challenge was issued by us to the same IP, at least MIN_DWELL_MS and at most MAX_AGE_MS ago
//   - the client solved a proof-of-work over the challenge nonce (POW_BITS leading zero bits)
//   - this IP hasn't been counted yet today (UTC); only a salted hash of the IP is stored
//
// Storage: Postgres (POSTGRES_* vars) in production, .data/views.json locally.
// Requires VIEWS_SECRET (random string) for signing and hashing.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = 'home';
export const POW_BITS = 16;
const MIN_DWELL_MS = 3000;
const MAX_AGE_MS = 10 * 60 * 1000;
const BOT_UA =
  /bot|crawl|spider|slurp|curl|wget|python|httpclient|http-client|axios|node-fetch|undici|go-http|java\/|okhttp|libwww|scrapy|headless|phantom|puppeteer|playwright|selenium|lighthouse|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack/i;

const secret = () => process.env.VIEWS_SECRET;
const hmac = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');
const today = () => new Date().toISOString().slice(0, 10);

function clientIp(req) {
  // On Vercel x-real-ip / x-forwarded-for are set by the edge and can't be spoofed by the client.
  const h = req.headers;
  const ip = h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

const ipTag = (ip) => hmac('ip:' + ip).slice(0, 16);
const visitorId = (ip, day) => hmac(`visitor:${day}:${ip}`);

function issueChallenge(ip) {
  const payload = `${Date.now()}.${crypto.randomBytes(12).toString('base64url')}.${ipTag(ip)}`;
  return `${payload}.${hmac(payload)}`;
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

// Returns null when valid, otherwise a short reason (only logged).
function checkChallenge(challenge, solution, ip) {
  if (typeof challenge !== 'string' || typeof solution !== 'string' || solution.length > 32) return 'malformed';
  const parts = challenge.split('.');
  if (parts.length !== 4) return 'malformed';
  const [ts, , tag, sig] = parts;
  const payload = parts.slice(0, 3).join('.');
  const expected = hmac(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 'bad signature';
  if (tag !== ipTag(ip)) return 'ip mismatch';
  const age = Date.now() - Number(ts);
  if (!(age >= MIN_DWELL_MS && age <= MAX_AGE_MS)) return 'too fast or expired';
  const digest = crypto.createHash('sha256').update(`${challenge}:${solution}`).digest();
  if (leadingZeroBits(digest) < POW_BITS) return 'bad proof of work';
  return null;
}

function checkBrowser(req) {
  const h = req.headers;
  if (!h['user-agent'] || BOT_UA.test(h['user-agent'])) return 'bot user agent';
  if (h['sec-fetch-site'] && h['sec-fetch-site'] !== 'same-origin') return 'cross-site';
  const origin = h.origin;
  const host = h['x-forwarded-host'] || h.host;
  if (!origin || !host) return 'no origin';
  try {
    if (new URL(origin).host !== host) return 'foreign origin';
  } catch {
    return 'bad origin';
  }
  if (!String(h['content-type'] || '').startsWith('application/json')) return 'bad content type';
  return null;
}

// ---- storage ----

let pool = null;
let tableReady = null;

async function getPool() {
  if (pool) return pool;
  const { default: pg } = await import('pg');
  pool = new pg.Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT) || 5432,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DATABASE,
    // The current server doesn't speak SSL; set POSTGRES_SSL=true for a host that does.
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 1,
  });
  tableReady ??= pool.query(`
    CREATE TABLE IF NOT EXISTS page_views (key text PRIMARY KEY, count bigint NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS page_view_visitors (day date NOT NULL, visitor text NOT NULL, PRIMARY KEY (day, visitor));
  `);
  try {
    await tableReady;
  } catch (err) {
    // Let the next request retry from scratch instead of reusing a failed setup.
    tableReady = null;
    pool.end().catch(() => {});
    pool = null;
    throw err;
  }
  return pool;
}

const pgStore = {
  async get() {
    const db = await getPool();
    const { rows } = await db.query('SELECT count FROM page_views WHERE key = $1', [KEY]);
    return Number(rows[0]?.count || 0);
  },
  async add(day, visitor) {
    const db = await getPool();
    const ins = await db.query(
      'INSERT INTO page_view_visitors (day, visitor) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [day, visitor]
    );
    if (Math.random() < 0.02) {
      db.query("DELETE FROM page_view_visitors WHERE day < CURRENT_DATE - 2").catch(() => {});
    }
    if (!ins.rowCount) return { count: await this.get(), counted: false };
    const { rows } = await db.query(
      `INSERT INTO page_views (key, count) VALUES ($1, 1)
       ON CONFLICT (key) DO UPDATE SET count = page_views.count + 1
       RETURNING count`,
      [KEY]
    );
    return { count: Number(rows[0].count), counted: true };
  },
};

const FILE = path.join(process.cwd(), '.data', 'views.json');

const fileStore = {
  async read() {
    try {
      const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
      return { count: data.count || 0, visitors: data.visitors || {} };
    } catch {
      return { count: 0, visitors: {} };
    }
  },
  async get() {
    return (await this.read()).count;
  },
  async add(day, visitor) {
    const data = await this.read();
    const seen = new Set(data.visitors[day] || []);
    if (seen.has(visitor)) return { count: data.count, counted: false };
    seen.add(visitor);
    data.count++;
    data.visitors = { [day]: [...seen] };
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(data));
    return { count: data.count, counted: true };
  },
};

// ---- handler ----

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!secret()) {
    console.error('[views] VIEWS_SECRET is not set');
    return res.status(500).json({ error: 'views unavailable' });
  }

  const store = process.env.POSTGRES_HOST ? pgStore : fileStore;
  const ip = clientIp(req);

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ count: await store.get(), challenge: issueChallenge(ip), bits: POW_BITS });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const rejected = checkBrowser(req) || checkChallenge(body.challenge, body.solution, ip);
    if (rejected) {
      console.warn('[views] rejected:', rejected);
      return res.status(200).json({ count: await store.get(), counted: false });
    }

    return res.status(200).json(await store.add(today(), visitorId(ip, today())));
  } catch (err) {
    console.error('[views]', err.message);
    return res.status(502).json({ error: 'views unavailable' });
  }
}
