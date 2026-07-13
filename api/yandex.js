import { Client } from '@dvxch/yandex-music';

const TOKEN = process.env.YANDEX_MUSIC_TOKEN;

// Keys for best-effort in-memory state across warm serverless invocations.
// This lets us implement "remember previous track, add to recent when it changes".
const CACHE_KEY = 'yandex-data';
const PLAYLOG_KEY = 'yandex-playlog-v1';
const LASTNP_KEY = 'yandex-lastnp-v1';

export default async function handler(req, res) {
  if (!TOKEN) {
    return res.status(500).json({ error: 'Yandex token not configured' });
  }

  const now = Date.now();
  if (globalThis[CACHE_KEY] && now - globalThis[CACHE_KEY].ts < 10000) {
    // Short in-memory cache (warm function).
    // Still attempt to apply any "previous np" accumulation using the *cached* np
    // so that even on a cache hit we can advance the recent list if the world moved.
    try {
      const cached = globalThis[CACHE_KEY].data;
      const cnp = cached && cached.nowPlaying;
      if (cnp && cnp.id && cnp.title) {
        let playLog = globalThis[PLAYLOG_KEY];
        if (!Array.isArray(playLog)) playLog = [];
        const prev = globalThis[LASTNP_KEY];
        if (prev && prev.id && prev.id !== cnp.id) {
          const dup = playLog.length > 0 && String(playLog[0].id) === String(prev.id);
          if (!dup) {
            playLog.unshift({
              id: String(prev.id), title: prev.title, artist: prev.artist || '',
              url: prev.url || `https://music.yandex.ru/track/${prev.id}`, art: prev.art || null,
            });
            if (playLog.length > 6) playLog.length = 6;
            console.log('📼 [prod/cached] previous moved to recent:', prev.title);
          }
        }
        globalThis[LASTNP_KEY] = { id: String(cnp.id), title: cnp.title, artist: cnp.artist||'', url: cnp.url, art: cnp.art };
        globalThis[PLAYLOG_KEY] = playLog;

        // Rebuild recent from the (now possibly updated) log + cached nowPlaying
        let fr = playLog.filter((t) => String(t.id) !== String(cnp.id)).slice(0, 3);
        if (fr.length === 0 && cached.recent) fr = cached.recent; // keep old if nothing new
        const freshResult = { nowPlaying: cached.nowPlaying, recent: fr.slice(0, 3) };
        globalThis[CACHE_KEY] = { data: freshResult, ts: now }; // refresh timestamp
        res.setHeader('Cache-Control', 'private, max-age=5, s-maxage=0');
        return res.json(freshResult);
      }
    } catch (_) {}
    res.setHeader('Cache-Control', 'private, max-age=5, s-maxage=0');
    return res.json(globalThis[CACHE_KEY].data);
  }

  let np = null;
  let recent = [];
  let queueRecent = [];
  let client = null;

  try {
    client = await new Client({ token: TOKEN }).init();

    // Always fetch queue (needed for accurate "recent" from current session).
    // We use it for np only as a last resort (no pause info available from queue).
    let currentQueue = null;
    try {
      const queues = await client.queuesList();
      if (queues?.length > 0) {
        currentQueue = await client.queue(queues[0].id);
      }
    } catch (e) {
      console.log('Yandex queue fetch (non-fatal):', e.message || e);
    }

    // Try realtime (Ynison) snapshot FIRST — following the pattern from examples/04-realtime.ts
    // Read the synchronous nowPlaying snapshot and use .paused directly.
    let usedRealtime = false;
    try {
      const rt = client.realtime({
        staleTimeoutMs: 120_000,
      });

      const snapshot = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(null);
        }, 4000); // max 4s wait for initial state

        rt.once('open', () => {
          setTimeout(() => {
            clearTimeout(timeout);
            const snap = rt.nowPlaying;
            resolve(snap);
          }, 300);
        });

        rt.on('error', () => {
          // ignore
        });

        rt.start().catch(() => {});
      });

      if (snapshot?.track?.title) {
        const paused = !!snapshot.paused;
        np = {
          id: String(snapshot.track.id),
          title: snapshot.track.title,
          artist: snapshot.track.artists?.map((a) => a.name).join(', ') || '',
          url: `https://music.yandex.ru/track/${snapshot.track.id}`,
          art: snapshot.track.coverUri ? `https://${String(snapshot.track.coverUri).replace('%%', '400x400')}` : null,
          isPlaying: !paused,
        };
        usedRealtime = true;
      }

      try { rt.stop(); } catch (_) {}
    } catch (e) {
      console.log('realtime snapshot (non-fatal):', e.message || e);
    }

    // Queue fallback for current track only if realtime gave us nothing.
    // Important: queue API does not tell us if paused, so we must not claim isPlaying:true.
    if (!usedRealtime && currentQueue) {
      const current = currentQueue?.tracks?.[currentQueue.currentIndex || 0];
      const track = current?.track || current;
      if (track && track.title) {
        np = {
          id: String(track.id),
          title: track.title,
          artist: track.artists?.map((a) => a.name).join(', ') || '',
          url: `https://music.yandex.ru/track/${track.id}`,
          art: track.coverUri ? `https://${String(track.coverUri).replace('%%', '400x400')}` : null,
          isPlaying: false,  // queue has no pause info; do not claim playing
        };
      }
    }

    // Build recent from the actual queue history (tracks before currentIndex)
    // This reflects what was really played in the current session/playlist/radio.
    // Much better than pure history for "what was played".
    queueRecent = [];
    if (currentQueue && Array.isArray(currentQueue.tracks) && currentQueue.tracks.length > 0) {
      let idx = typeof currentQueue.currentIndex === 'number' ? currentQueue.currentIndex : currentQueue.tracks.length;

      // If we have an np id, find its position in the queue to get accurate previous
      if (np && np.id) {
        const foundIdx = currentQueue.tracks.findIndex((item) => {
          const t = item?.track || item;
          return t && String(t.id) === np.id;
        });
        if (foundIdx >= 0) idx = foundIdx;
      }

      const previous = currentQueue.tracks.slice(0, idx);
      queueRecent = previous
        .reverse()
        .map((item) => {
          const track = item?.track || item;
          if (!track || !track.title) return null;
          return {
            id: String(track.id),
            title: track.title,
            artist: track.artists?.map((a) => a.name).join(', ') || '',
            url: `https://music.yandex.ru/track/${track.id}`,
            art: track.coverUri ? `https://${String(track.coverUri).replace('%%', '400x400')}` : null,
          };
        })
        .filter(Boolean)
        .slice(0, 4);
    }

    if (queueRecent.length > 0) {
      recent = queueRecent;
    } else {
      // Fallback to music history only if no queue context
      try {
        const h = await client.musicHistory();
        const ids = [];
        const seen = new Set();

        for (const tab of h?.historyTabs || []) {
          for (const group of (tab.items || [])) {
            const trs = group.tracks || [];
            for (let j = trs.length - 1; j >= 0; j--) {
              const tid = trs[j]?.data?.itemId?.trackId;
              if (tid && !seen.has(tid)) {
                seen.add(tid);
                ids.push(tid);
              }
              if (ids.length >= 5) break;
            }
            if (ids.length >= 5) break;
          }
          if (ids.length >= 5) break;
        }

        if (ids.length > 0) {
          const ts = await client.tracks(ids);
          recent = ts
            .filter((t) => t && t.title)
            .map((t) => ({
              id: String(t.id),
              title: t.title,
              artist: t.artists?.map((a) => a.name).join(', ') || '',
              url: `https://music.yandex.ru/track/${t.id}`,
              art: t.coverUri ? `https://${t.coverUri.replace('%%', '400x400')}` : null,
            }));
        }
      } catch (e) {
        console.log('Yandex history fetch (non-fatal):', e.message || e);
      }
    }
  } catch (error) {
    // Client init or fatal error — return graceful empty
    console.error('Yandex client error (returning empty):', error.message || error);
  }

  // If nothing live right now, promote the most recent actually-played item as "last played"
  if (!np && recent.length > 0 && recent[0].title) {
    np = { ...recent[0], isPlaying: false };
  }

  // =====================================================
  // "Recent" accumulation: the core requirement
  // Take what was playing, remember it. When the next track
  // becomes current, add the previous one to recent.
  // This runs on every request and uses globalThis so that
  // warm Vercel function instances accumulate history across
  // the 15s frontend polls (similar to the long-running server.js).
  // =====================================================
  let playLog = globalThis[PLAYLOG_KEY];
  if (!Array.isArray(playLog)) playLog = [];

  const prevLast = globalThis[LASTNP_KEY];

  if (np && np.id && np.title) {
    if (prevLast && prevLast.id && prevLast.id !== np.id) {
      const dup = playLog.length > 0 && String(playLog[0].id) === String(prevLast.id);
      if (!dup) {
        playLog.unshift({
          id: String(prevLast.id),
          title: prevLast.title,
          artist: prevLast.artist || '',
          url: prevLast.url || `https://music.yandex.ru/track/${prevLast.id}`,
          art: prevLast.art || null,
        });
        if (playLog.length > 6) playLog.length = 6;
        // Helpful log (visible in Vercel function logs)
        console.log('📼 [prod] previous moved to recent:', prevLast.title);
      }
    }
    // Remember current for next poll's comparison
    globalThis[LASTNP_KEY] = {
      id: String(np.id),
      title: np.title,
      artist: np.artist || '',
      url: np.url,
      art: np.art,
    };
  }

  globalThis[PLAYLOG_KEY] = playLog;

  // One-time seed from queue "previous" items if our observed log is empty.
  // queueRecent is already ordered with [0] = most-recent previous (closest to now).
  // playLog uses the same convention ([0] = most recently finished).
  if (playLog.length === 0 && Array.isArray(queueRecent) && queueRecent.length > 0) {
    const toSeed = queueRecent.filter((q) => q && q.id).map((q) => ({ ...q }));
    // push in order so resulting [0] === queueRecent[0]
    playLog.push(...toSeed);
    globalThis[PLAYLOG_KEY] = playLog;
  }

  // Prefer observed play log for recent (this gives the shifting behavior the user wants)
  let finalRecent = playLog
    .filter((t) => !np || String(t.id) !== String(np.id))
    .slice(0, 3);

  // If we have fewer than 3 from live observation (e.g. just after cold start),
  // seed/augment once from music history. We do it only when playLog is still short.
  const needHistorySeed = finalRecent.length < 3 && playLog.length < 2;
  if (needHistorySeed && client) {
    try {
      const h = await client.musicHistory();
      const ids = [];
      const seen = new Set();

      for (const tab of h?.historyTabs || []) {
        for (const group of (tab.items || [])) {
          const trs = group.tracks || [];
          for (let j = trs.length - 1; j >= 0; j--) {
            const tid = trs[j]?.data?.itemId?.trackId;
            if (tid && !seen.has(tid)) {
              seen.add(tid);
              ids.push(tid);
            }
            if (ids.length >= 6) break;
          }
          if (ids.length >= 6) break;
        }
        if (ids.length >= 6) break;
      }

      if (ids.length > 0) {
        const ts = await client.tracks(ids);
        const hist = ts
          .filter((t) => t && t.title)
          .map((t) => ({
            id: String(t.id),
            title: t.title,
            artist: t.artists?.map((a) => a.name).join(', ') || '',
            url: `https://music.yandex.ru/track/${t.id}`,
            art: t.coverUri ? `https://${t.coverUri.replace('%%', '400x400')}` : null,
          }));

        for (const item of hist) {
          if (finalRecent.length >= 3) break;
          const already = finalRecent.some((r) => String(r.id) === String(item.id));
          const isCurrent = np && String(item.id) === String(np.id);
          if (!already && !isCurrent) {
            finalRecent.push(item);
          }
        }
      }
    } catch (e) {
      console.log('Yandex history augment (non-fatal):', e.message || e);
    }
  }

  // Also mix in any good queueRecent we got earlier (they are session-fresh)
  // but keep the observed playLog in front.
  if (queueRecent && queueRecent.length > 0) {
    for (const q of queueRecent) {
      if (finalRecent.length >= 3) break;
      const already = finalRecent.some((r) => String(r.id) === String(q.id));
      const isCurrent = np && String(q.id) === String(np.id);
      if (!already && !isCurrent) finalRecent.push(q);
    }
  }

  const result = {
    nowPlaying: np,
    recent: finalRecent.slice(0, 3),
  };

  globalThis[CACHE_KEY] = { data: result, ts: now };

  // IMPORTANT: do not allow edge caching of now-playing / recent.
  // The data is personal and must reflect reality quickly.
  res.setHeader('Cache-Control', 'private, max-age=8, s-maxage=0');
  return res.json(result);
}

