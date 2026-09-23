// Page view counter.
// Production: Postgres (POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE).
// Local dev without POSTGRES_HOST: a JSON file in .data/.
// GET returns the count, POST increments it and returns the new count.

import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = 'home';

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
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  tableReady ??= pool.query(
    'CREATE TABLE IF NOT EXISTS page_views (key text PRIMARY KEY, count bigint NOT NULL DEFAULT 0)'
  );
  await tableReady;
  return pool;
}

async function pgViews(increment) {
  const db = await getPool();
  const { rows } = increment
    ? await db.query(
        `INSERT INTO page_views (key, count) VALUES ($1, 1)
         ON CONFLICT (key) DO UPDATE SET count = page_views.count + 1
         RETURNING count`,
        [KEY]
      )
    : await db.query('SELECT count FROM page_views WHERE key = $1', [KEY]);
  return Number(rows[0]?.count || 0);
}

const FILE = path.join(process.cwd(), '.data', 'views.json');

async function fileViews(increment) {
  let count = 0;
  try {
    count = JSON.parse(await fs.readFile(FILE, 'utf8')).count || 0;
  } catch {}
  if (increment) {
    count++;
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify({ count }));
  }
  return count;
}

export default async function handler(req, res) {
  const increment = req.method === 'POST';
  res.setHeader('Cache-Control', 'no-store');
  try {
    const count = process.env.POSTGRES_HOST ? await pgViews(increment) : await fileViews(increment);
    return res.status(200).json({ count });
  } catch (err) {
    console.error('[views]', err.message);
    return res.status(502).json({ error: 'views unavailable' });
  }
}
