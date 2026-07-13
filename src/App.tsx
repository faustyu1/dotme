import { useEffect, useState, useCallback } from 'react'

interface SpotifyTrack {
  title: string
  artist: string
  url?: string
  art?: string
  isPlaying?: boolean
}

interface SpotifyData {
  nowPlaying?: SpotifyTrack | null
  recent?: SpotifyTrack[]
}

const SOCIALS = [
  {
    key: 't',
    href: 'https://t.me/faustyu',
    label: 'Telegram — @faustyu',
    tip: '@faustyu',
    svg: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M21.9 4.3 18.7 19.4c-.24 1.06-.87 1.32-1.76.82l-4.86-3.58-2.35 2.26c-.26.26-.48.48-.98.48l.35-4.95L18.1 5.9c.4-.36-.08-.56-.62-.2L6.55 12.4l-4.8-1.5c-1.04-.32-1.06-1.04.22-1.54l18.8-7.24c.86-.32 1.62.2 1.33 2.18z" />
      </svg>
    ),
  },
  {
    key: 'g',
    href: 'https://github.com/faustyu1',
    label: 'GitHub — @faustyu1',
    tip: '@faustyu1',
    svg: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.22-3.37-1.22-.46-1.18-1.11-1.5-1.11-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.05 0-1.11.39-2.02 1.03-2.74-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.74 0 3.92-2.34 4.78-4.57 5.04.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.03 10.03 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
      </svg>
    ),
  },
  {
    key: 'k',
    href: 'https://x.com/dshashimov',
    label: 'X — @dshashimov',
    tip: '@dshashimov',
    svg: (
      <svg viewBox="0 0 300 300.251" fill="currentColor" aria-hidden="true">
        <path d="M178.57 127.15 290.27 0h-26.46l-97.03 110.38L89.34 0H0l117.13 166.93L0 300.25h26.46l102.4-116.59 81.8 116.59h89.34M36.01 19.54H76.66l187.13 262.13h-40.66"/>
      </svg>
    ),
  },
  {
    key: 'm',
    href: 'mailto:meow@faustyu.xyz',
    label: 'Email — meow@faustyu.xyz',
    tip: 'meow@faustyu.xyz',
    copy: 'meow@faustyu.xyz',
    svg: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    ),
  },
]

export default function App() {
  const [toastMessage, setToastMessage] = useState('')
  const [clock, setClock] = useState('--:--:--')

  const [spotify, setSpotify] = useState<{ np: SpotifyTrack | null; recent: SpotifyTrack[] }>({ np: null, recent: [] })

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg)
    const timer = setTimeout(() => setToastMessage(''), 1600)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString())
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return

    const canvas = document.getElementById('stars') as HTMLCanvasElement
    if (!canvas) return

    const ctx = canvas.getContext('2d', { alpha: true }) as CanvasRenderingContext2D
    if (!ctx) return

    let w = 0, h = 0
    type Star = { x: number; y: number; r: number; a: number; s: number }
    let pts: Star[] = []

    function init() {
      w = canvas.width = window.innerWidth
      h = canvas.height = window.innerHeight

      const n = Math.min(140, Math.floor((w * h) / 12000))
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.3 + 0.3,
        a: Math.random(),
        s: Math.random() * 0.02 + 0.004,
      }))
    }

    function loop() {
      ctx.clearRect(0, 0, w, h)
      for (const p of pts) {
        p.a += p.s
        const alpha = 0.35 + Math.abs(Math.sin(p.a)) * 0.55
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, 7)
        ctx.fillStyle = `rgba(255,255,255,${alpha})`
        ctx.fill()
      }
      requestAnimationFrame(loop)
    }

    init()
    loop()

    const onResize = () => init()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const handleSocialClick = (e: React.MouseEvent<HTMLAnchorElement>, social: typeof SOCIALS[0]) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ripple = document.createElement('span')
    ripple.className = 'ripple'
    const size = Math.max(rect.width, rect.height)
    ripple.style.width = ripple.style.height = `${size}px`
    ripple.style.left = `${e.clientX - rect.left}px`
    ripple.style.top = `${e.clientY - rect.top}px`
    e.currentTarget.appendChild(ripple)
    setTimeout(() => ripple.remove(), 450)

    if (social.copy && navigator.clipboard) {
      navigator.clipboard.writeText(social.copy).then(() => {
        showToast('copied  ' + social.copy)
      }).catch(() => {})
    }
  }

  useEffect(() => {
    let cancelled = false

    async function load(attempt = 0) {
      try {
        const res = await fetch('/api/yandex', { cache: 'no-store' })
        if (!res.ok) throw new Error('bad status')
        const data: SpotifyData = await res.json()
        if (cancelled) return

        const np = data.nowPlaying ? { ...data.nowPlaying } : null
        setSpotify({ np, recent: data.recent || [] })
      } catch {
        if (!cancelled && attempt < 2) {
          setTimeout(() => load(attempt + 1), 800)
        } else if (!cancelled) {
          setSpotify({ np: null, recent: [] })
        }
      }
    }

    load()
    const iv = setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [])



  return (
    <div>
      <canvas id="stars" aria-hidden="true" />

      <main className="card" id="card">
        <img
          className="portrait"
          src="https://t.me/i/userpic/320/faustyu.jpg"
          alt="larpcoup"
          draggable={false}
        />

        <div className="name">larpcoup</div>

        <p className="intro">
          <a href="https://t.me/bot4pi" target="_blank" rel="noopener">t.me/bot4pi</a>
        </p>

        <hr className="rule" />

        <nav className="socials" aria-label="contacts">
          {SOCIALS.map((social) => (
            <a
              key={social.key}
              className="social"
              href={social.href}
              target="_blank"
              rel="noopener noreferrer"
              data-tip={social.tip}
              aria-label={social.label}
              onClick={(e) => handleSocialClick(e, social)}
            >
              {social.svg}
            </a>
          ))}
        </nav>

        <section className={`spotify ${spotify.np?.isPlaying ? 'is-playing' : ''}`} aria-label="Yandex Music">
            <hr className="rule" />
            {spotify.np ? (
              <a className="np" href={spotify.np.url || '#'} target="_blank" rel="noopener noreferrer">
                <span
                  className="np-art"
                  style={{ backgroundImage: spotify.np.art ? `url("${spotify.np.art}")` : undefined }}
                  aria-hidden="true"
                />
                <span className="np-body">
                  <span className="np-label">{spotify.np?.isPlaying ? 'now playing' : 'last played'}</span>
                  <span className="np-title">{spotify.np.title}</span>
                  <span className="np-artist">{spotify.np.artist}</span>
                </span>
                <span className="np-eq" aria-hidden="true"><i /><i /><i /><i /></span>
              </a>
            ) : null}
            {spotify.recent?.length > 0 && (
              <ul className="recent">
                {spotify.recent.slice(0, 3).map((t, i) => (
                  <li key={i}>
                    {t.url ? (
                      <a href={t.url} target="_blank" rel="noopener noreferrer">
                        <span className="r-dot">♪</span>
                        <span className="r-text">{t.title} <span className="r-artist">— {t.artist}</span></span>
                      </a>
                    ) : (
                      <span>
                        <span className="r-dot">♪</span>
                        <span className="r-text">{t.title} <span className="r-artist">— {t.artist}</span></span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

        <footer className="foot">
          <span className="clock">{clock}</span>
        </footer>
      </main>

      <div className={`toast ${toastMessage ? 'show' : ''}`} role="status" aria-live="polite">
        {toastMessage}
      </div>
    </div>
  )
}
