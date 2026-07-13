import express from 'express';
import dotenv from 'dotenv';
import { Client, ANDROID_DEVICE_INFO, liveProgressMs } from '@dvxch/yandex-music';

dotenv.config({ path: '.env.server' });

const app = express();
const PORT = 4000;

const TOKEN = process.env.YANDEX_MUSIC_TOKEN;

if (!TOKEN) {
  console.error('❌ YANDEX_MUSIC_TOKEN is not set in .env.server');
  process.exit(1);
}

const client = await new Client({ token: TOKEN }).init();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 45 * 1000;

let nowPlaying = null;
let realtime = null;

let playLog = [];

function updateCurrentTrack(newData) {
  if (!newData || !newData.title) return;

  const newT = {
    id: String(newData.id || ''),
    title: newData.title,
    artist: newData.artist || (newData.artists ? newData.artists.map(a => a.name).join(', ') : '') || '',
    url: newData.url || (newData.id ? `https://music.yandex.ru/track/${newData.id}` : ''),
    art: newData.art || (newData.coverUri ? `https://${String(newData.coverUri).replace('%%', '400x400')}` : null),
  };

  if (nowPlaying && nowPlaying.id && nowPlaying.id !== newT.id) {
    const dup = playLog[0] && playLog[0].id === nowPlaying.id;
    if (!dup) {
      playLog.unshift({
        id: nowPlaying.id,
        title: nowPlaying.title,
        artist: nowPlaying.artist,
        url: nowPlaying.url,
        art: nowPlaying.art,
      });
      if (playLog.length > 4) playLog.length = 4;
      console.log('📼 previous moved to history:', nowPlaying.title);
    }
  }

  nowPlaying = {
    id: newT.id,
    title: newT.title,
    artist: newT.artist,
    url: newT.url,
    art: newT.art,
    // isPlaying is NEVER stored here anymore. It's computed fresh in /api/yandex
    // purely from lastStateAgeMs + paused (per your request).
  };

  const already = playLog[0] && playLog[0].id === nowPlaying.id;
  if (!already) {
    playLog.unshift({
      id: nowPlaying.id,
      title: nowPlaying.title,
      artist: nowPlaying.artist,
      url: nowPlaying.url,
      art: nowPlaying.art,
    });
    if (playLog.length > 4) playLog.length = 4;
  }
}

try {
  realtime = client.realtime({
    // Android for richer state (as in original setup), stale like example
    deviceInfo: ANDROID_DEVICE_INFO,
    staleTimeoutMs: 120_000,
    // resolver to ensure track is populated in snapshot
    resolveTrack: async (playableId) => {
      try {
        const ts = await client.tracks([playableId]);
        return ts && ts[0] ? ts[0] : null;
      } catch (e) {
        return null;
      }
    }
  });

  console.log(`device id: ${realtime.deviceIdValue}`); // stable across reconnects (from the example)

  realtime.on('open', () => console.log('connected to Ynison'));
  realtime.on('error', (err) => console.error('realtime error:', err.message));
  realtime.on('stale', (idleMs) => console.log(`no frames for ${Math.round(idleMs / 1000)}s — reconnecting`));
  realtime.on('reconnect', (ms) => console.log(`reconnecting in ${ms}ms`));

  realtime.on('trackChange', ({ track }) => {
    if (!track || !track.title) return;
    // Exactly like the example: just report the new track.
    // Playing state is determined from .paused (see snapshot below and playStateChange).
    updateCurrentTrack({
      id: track.id,
      title: track.title,
      artist: track.artists?.map(a => a.name).join(', ') || '',
      url: `https://music.yandex.ru/track/${track.id}`,
      art: track.coverUri,
      // isPlaying not passed — decided only in /api using lastStateAgeMs
    });
    console.log('now playing:', track?.title, '—', track?.artists?.[0]?.name);
  });

  realtime.on('playStateChange', (paused) => {
    console.log(paused ? 'paused' : 'playing');
  });

  realtime.on('state', (state) => console.log(`position: ${Math.round(liveProgressMs(state) / 1000)}s`));

  realtime.start().catch((e) => console.log('realtime start err:', e.message || e));
  console.log('✅ Realtime Ynison started');

  setTimeout(() => {
    try {
      const snap = realtime?.nowPlaying;
      if (snap?.track?.title && !nowPlaying) {
        updateCurrentTrack({
          id: snap.track.id,
          title: snap.track.title,
          artist: snap.track.artists?.map(a => a.name).join(', ') || '',
          art: snap.track.coverUri,
          // no isPlaying — only /api decides using lastStateAgeMs + 5min rule
        });
      }
    } catch (e) {}
  }, 1500);

  setTimeout(async () => {
    try {
      if (playLog.length >= 2) return;
      const h = await client.musicHistory();
      const ids = [];
      const seen = new Set();
      for (const tab of h?.historyTabs || []) {
        for (const group of (tab.items || [])) {
          const trs = group.tracks || [];
          for (let j = trs.length-1; j>=0; j--) {
            const tid = trs[j]?.data?.itemId?.trackId;
            if (tid && !seen.has(tid)) { seen.add(tid); ids.push(tid); }
            if (ids.length >= 2) break;
          }
          if (ids.length >= 2) break;
        }
        if (ids.length >= 2) break;
      }
      if (ids.length) {
        const ts = await client.tracks(ids);
        const toAdd = ts.filter(t=>t&&t.title).map(t => ({id:String(t.id), title:t.title, artist: t.artists?.map(a=>a.name).join(', ')||'', url:`https://music.yandex.ru/track/${t.id}`, art: t.coverUri ? `https://${t.coverUri.replace('%%','400x400')}` : null }));
        playLog.push(...toAdd.reverse());
        if (playLog.length > 4) playLog.length = 4;
        console.log('📼 lightly seeded playLog with last history for initial recent');
      }
    } catch(e){}
  }, 2200);
} catch (e) {
  console.log('Realtime setup skipped:', e.message);
}

async function pollNowPlaying() {
  try {
    const queues = await client.queuesList();
    if (queues?.length > 0) {
      const q = await client.queue(queues[0].id);
      const current = q?.tracks?.[q.currentIndex || 0];
      const track = current?.track || current;
      if (track && track.title) {
        // Queue has no pause info. We pass no isPlaying; decision is purely in /api using lastStateAgeMs.
        updateCurrentTrack({
          id: track.id,
          title: track.title,
          artist: track.artists?.map(a => a.name).join(', ') || '',
          url: `https://music.yandex.ru/track/${track.id}`,
          art: track.coverUri,
          // intentionally no isPlaying
        });
      }
    }
  } catch (e) {
  }
}
setInterval(pollNowPlaying, 15000);
pollNowPlaying();

app.get('/api/yandex', async (req, res) => {
  let responseNowPlaying = null;

  // Use the realtime snapshot. isPlaying is true only if we have fresh data (<5min)
  // and the paused flag is false.
  if (realtime && realtime.nowPlaying && realtime.nowPlaying.track) {
    const np = realtime.nowPlaying;  // variable name as in the example
    const tr = np.track;

    if (tr && tr.title) {
      const age = realtime.lastStateAgeMs ?? 999999999;
      const isStale = age > 5 * 60 * 1000; // 5 minutes no updates from Ynison

      // Simple rule as requested:
      // - if last update > 5min ago → was playing before, but now no data → not playing
      // - else use the paused flag directly
      const isPlaying = !isStale && !np.paused;

      const pos = Math.round(np.progressMs / 1000);
      const dur = Math.round(np.durationMs / 1000);
      const status = isStale ? 'STALE (was playing)' : (np.paused ? '⏸' : '▶');
      console.log(`[snapshot] ${tr.title} ${status} ${pos}/${dur}s (isPlaying=${isPlaying}, age=${age}ms)`);

      responseNowPlaying = {
        id: String(tr.id),
        title: tr.title,
        artist: tr.artists?.map((a) => a.name).join(', ') || '',
        url: `https://music.yandex.ru/track/${tr.id}`,
        art: tr.coverUri ? `https://${tr.coverUri.replace('%%', '400x400')}` : null,
        isPlaying,
      };

      // no longer sync isPlaying into nowPlaying — computed only in response

    }
  }

  // fallback to last known track info (no isPlaying stored in it)
  // if we have to fall back, it means no current snapshot → treat as not playing
  if (!responseNowPlaying && nowPlaying && nowPlaying.title) {
    responseNowPlaying = { ...nowPlaying, isPlaying: false };
  }

  if (responseNowPlaying && !responseNowPlaying.title) responseNowPlaying = null;

  let recent = playLog
    .filter(t => !responseNowPlaying || !responseNowPlaying.id || t.id !== responseNowPlaying.id)
    .slice(0, 3);

  if (!responseNowPlaying && recent.length > 0 && recent[0].title) {
    responseNowPlaying = { ...recent[0], isPlaying: false };
  }

  // Final staleness rule: if no fresh data from Ynison for >5min, force not playing
  if (responseNowPlaying && realtime && typeof realtime.lastStateAgeMs === 'number') {
    if (realtime.lastStateAgeMs > 5 * 60 * 1000) {
      responseNowPlaying.isPlaying = false;
    }
  }

  const result = { nowPlaying: responseNowPlaying, recent };
  res.json(result);
});

// Debug endpoint to inspect realtime state (modeled after the example)
app.get('/debug/yandex', (req, res) => {
  const rt = realtime || {};
  const snap = rt.nowPlaying || null;
  const age = rt.lastStateAgeMs ?? null;

  res.json({
    cacheNowPlaying: nowPlaying,
    realtimeRunning: rt.isRunning,
    lastStateAgeMs: age,
    snapshot: snap ? {
      playableId: snap.playableId,
      title: snap.track?.title,
      paused: snap.paused,
      isPlaying: (snap.track && age != null && age <= 5 * 60 * 1000) ? !snap.paused : false,
      progressMs: snap.progressMs,   // already live-extrapolated
      durationMs: snap.durationMs,
      // live position using the helper (same as what progressMs uses)
      liveProgressSec: snap.track ? Math.round((rt.liveProgressMs ? rt.liveProgressMs() : snap.progressMs) / 1000) : null,
    } : null,
    hasTrackInSnapshot: !!(snap && snap.track),
    rawStatePaused: rt.state ? rt.state.paused : null,
  });
});

app.listen(PORT, () => {
  console.log(`Yandex Music proxy on http://localhost:${PORT}`);
});