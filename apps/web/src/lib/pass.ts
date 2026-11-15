// The API only serves clients that hold a short-lived pass from the Worker's /_pass endpoint,
// which it issues after a Cloudflare Turnstile check. The pass is cached in memory until a
// minute before it expires, and a 403 pass_required response triggers one fresh solve.

const SITE_KEY = '0x4AAAAAAGBpnIiMWoBhsbMb'
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'
const SOLVE_TIMEOUT_MS = 30_000

type Turnstile = {
  render: (
    el: HTMLElement,
    options: {
      sitekey: string
      appearance: 'interaction-only'
      callback: (token: string) => void
      'error-callback': () => void
    },
  ) => string
  remove: (id: string) => void
}

declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

let script: Promise<Turnstile> | null = null

function loadTurnstile(): Promise<Turnstile> {
  script ??= new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    el.async = true
    el.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile'))
    el.onerror = () => {
      script = null
      reject(new Error('turnstile script'))
    }
    document.head.appendChild(el)
  })
  return script
}

async function solveTurnstile(): Promise<string> {
  const turnstile = await loadTurnstile()
  const host = document.createElement('div')
  document.body.appendChild(host)
  let widgetId = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turnstile timeout')), SOLVE_TIMEOUT_MS)
      widgetId = turnstile.render(host, {
        sitekey: SITE_KEY,
        appearance: 'interaction-only',
        callback: (token) => {
          clearTimeout(timer)
          resolve(token)
        },
        'error-callback': () => {
          clearTimeout(timer)
          reject(new Error('turnstile error'))
        },
      })
    })
  } finally {
    if (widgetId) turnstile.remove(widgetId)
    host.remove()
  }
}

async function requestPass(): Promise<{ pass: string; expires: number }> {
  const token = await solveTurnstile()
  const res = await fetch(`${API_URL}/_pass`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw new Error(`pass ${res.status}`)
  return res.json()
}

let cached: { pass: string; expires: number } | null = null
let pending: Promise<string> | null = null

async function getPass(force: boolean): Promise<string> {
  if (!force && cached && cached.expires - 60 > Date.now() / 1000) return cached.pass
  pending ??= requestPass()
    .then((fresh) => {
      cached = fresh
      return fresh.pass
    })
    .finally(() => {
      pending = null
    })
  return pending
}

type PassFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function createPassFetch(
  pass: (force: boolean) => Promise<string>,
  send: PassFetch = fetch,
): PassFetch {
  async function withPass(
    input: string | URL | Request,
    init: RequestInit | undefined,
    force: boolean,
  ) {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    try {
      headers.set('x-dv-pass', await pass(force))
    } catch {
      // No pass (blocked script, offline): send without one and let the API decide.
    }
    return send(input, { ...init, headers })
  }

  return async (input, init) => {
    const res = await withPass(input, init, false)
    if (res.status !== 403) return res
    const body = await res
      .clone()
      .json()
      .catch(() => null)
    if (body?.error !== 'pass_required') return res
    return withPass(input, init, true)
  }
}

export const passFetch = createPassFetch(getPass) as typeof fetch
