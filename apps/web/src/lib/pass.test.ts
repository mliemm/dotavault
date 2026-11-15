import { expect, test } from 'bun:test'
import { createPassFetch } from './pass'

const denied = () => new Response(JSON.stringify({ error: 'pass_required' }), { status: 403 })

test('retries once with a fresh pass after pass_required', async () => {
  const seen: string[] = []
  const send = async (_: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('x-dv-pass') ?? '')
    return seen.length === 1 ? denied() : new Response('ok')
  }
  const fetchWithPass = createPassFetch(async (force) => (force ? 'fresh' : 'old'), send as never)
  const res = await fetchWithPass('https://x/matches/1')
  expect(await res.text()).toBe('ok')
  expect(seen).toEqual(['old', 'fresh'])
})

test('does not retry other 403s and still sends when no pass can be had', async () => {
  let calls = 0
  const send = async () => {
    calls++
    return new Response('{"error":"forbidden"}', { status: 403 })
  }
  const fetchWithPass = createPassFetch(async () => {
    throw new Error('blocked')
  }, send as never)
  expect((await fetchWithPass('https://x/matches/1')).status).toBe(403)
  expect(calls).toBe(1)
})
