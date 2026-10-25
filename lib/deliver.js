// Handing a transfer to its payee over Nostr. The payee's wallet has a Nostr
// key derived from its seed and puts it in its pay links (&to=<pubkey>). The
// payer encrypts the transfer to it (NIP-44 v2) and publishes it as a kind
// 1059 event (the gift-wrap kind, which relays keep) signed by a throwaway
// key, so the event shows neither who paid nor what. The payee's wallet asks
// relays for kind 1059 events tagged with its key and takes the transfers in.
import { schnorr, sha256 } from './deps.js'
import { bytesToHex, concat, hexToBytes } from './bytes.js'
import { conversationKey, decrypt, encrypt } from './nip44.js'
import { publish } from './nostr.js'

export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev', 'wss://nostr.mom']
const KIND = 1059
const TYPE = 'rgb-transfer'

/** This wallet's Nostr key for receiving transfers: { secret, pubkey (hex) }. */
export function nostrKey (seed) {
  const secret = sha256(concat(new TextEncoder().encode('bunting nostr'), seed))
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(secret)) }
}

function sign (secret, ev) {
  ev.pubkey = bytesToHex(schnorr.getPublicKey(secret))
  ev.id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))))
  ev.sig = bytesToHex(schnorr.sign(hexToBytes(ev.id), secret))
  return ev
}

/** Encrypts `message` (an object) to `to` and publishes it; resolves to { [relay]: 'ok' | reason }. */
export async function sendTo (to, message) {
  if (!/^[0-9a-f]{64}$/.test(to)) throw new Error('not a Nostr public key')
  const throwaway = crypto.getRandomValues(new Uint8Array(32))
  const content = encrypt(JSON.stringify({ type: TYPE, v: 1, ...message }), conversationKey(throwaway, to))
  const ev = sign(throwaway, { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', to]], content })
  return publish(ev, { relays: RELAYS })
}

/** Transfers sent to this key since `since` (unix seconds): [{ id, created_at, message }]. */
function readEvent ({ secret }, ev) {
  const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))))
  if (id !== ev.id || !schnorr.verify(hexToBytes(ev.sig), hexToBytes(id), hexToBytes(ev.pubkey))) return null
  const message = JSON.parse(decrypt(ev.content, conversationKey(secret, ev.pubkey)))
  return message.type === TYPE ? { id: ev.id, created_at: ev.created_at, message } : null
}

/**
 * Keeps a subscription open on every relay for transfers sent to this key
 * from now on, reconnecting with backoff; calls onTransfer for each new one.
 * Returns a function that stops listening.
 */
export function listen (key, onTransfer) {
  const seen = new Set()
  let stopped = false
  const sockets = []
  for (const url of RELAYS) {
    let backoff = 2000
    const open = () => {
      if (stopped) return
      let ws
      try { ws = new WebSocket(url) } catch { return setTimeout(open, backoff *= 2) }
      sockets.push(ws)
      ws.onopen = () => { backoff = 2000; ws.send(JSON.stringify(['REQ', 'live', { kinds: [KIND], '#p': [key.pubkey], since: Math.floor(Date.now() / 1000) - 60 }])) }
      ws.onmessage = m => {
        try {
          const msg = JSON.parse(m.data)
          if (msg[0] !== 'EVENT' || seen.has(msg[2].id)) return
          seen.add(msg[2].id)
          const it = readEvent(key, msg[2])
          if (it) onTransfer(it)
        } catch {}
      }
      ws.onclose = () => { if (!stopped) setTimeout(open, backoff = Math.min(backoff * 2, 60000)) }
    }
    open()
  }
  return () => { stopped = true; for (const ws of sockets) try { ws.close() } catch {} }
}

export async function inbox ({ secret, pubkey }, { since = 0, timeoutMs = 8000 } = {}) {
  const found = new Map()
  await Promise.all(RELAYS.map(url => new Promise(resolve => {
    let ws
    const done = () => { try { ws?.close() } catch {} resolve() }
    const timer = setTimeout(done, timeoutMs)
    try { ws = new WebSocket(url) } catch { clearTimeout(timer); return resolve() }
    ws.onerror = () => { clearTimeout(timer); done() }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'in', { kinds: [KIND], '#p': [pubkey], since, limit: 50 }]))
    ws.onmessage = m => {
      try {
        const msg = JSON.parse(m.data)
        if (msg[0] === 'EOSE') { clearTimeout(timer); return done() }
        if (msg[0] !== 'EVENT' || found.has(msg[2].id)) return
        const it = readEvent({ secret, pubkey }, msg[2])
        if (it) found.set(it.id, it)
      } catch {}
    }
  })))
  return [...found.values()].sort((a, b) => a.created_at - b.created_at)
}
