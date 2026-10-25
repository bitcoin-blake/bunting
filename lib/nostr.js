// Handing a signed transaction to Nostr relays, as Reef does (sidestr SPEC
// section 11): a kind 23503 event whose content is the transaction hex, signed
// by a throwaway key. A producer with a txbt4 node broadcasts it if, and only
// if, its node's default policy accepts it.
import { schnorr, sha256 } from './deps.js'
import { bytesToHex, hexToBytes } from './bytes.js'

export const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://nostr.oxtr.dev']
const PARENT_TX_KIND = 23503
const CHAIN = 'sidestr:tally'

export function parentTxEvent (hex) {
  const key = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : crypto.getRandomValues(new Uint8Array(32))
  const ev = { pubkey: bytesToHex(schnorr.getPublicKey(key)), created_at: Math.floor(Date.now() / 1000), kind: PARENT_TX_KIND, tags: [['chain', CHAIN]], content: hex }
  ev.id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))))
  ev.sig = bytesToHex(schnorr.sign(hexToBytes(ev.id), key))
  return ev
}

/** Publishes to every relay; resolves to { [relay]: 'ok' | reason } after each answers or times out. */
export function publish (event, { relays = RELAYS, timeout = 8000 } = {}) {
  return Promise.all(relays.map(url => new Promise(resolve => {
    let ws
    const done = r => { try { ws?.close() } catch {} resolve([url, r]) }
    const timer = setTimeout(() => done('no answer'), timeout)
    try { ws = new WebSocket(url) } catch (e) { clearTimeout(timer); return done(e.message) }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]))
    ws.onmessage = m => {
      try {
        const [type, id, ok, reason] = JSON.parse(m.data)
        if (type === 'OK' && id === event.id) { clearTimeout(timer); done(ok ? 'ok' : reason || 'refused') }
      } catch {}
    }
    ws.onerror = () => { clearTimeout(timer); done('connection failed') }
  }))).then(Object.fromEntries)
}
