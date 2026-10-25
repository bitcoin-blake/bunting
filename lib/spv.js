// Checking "is it mined?" in this tab instead of taking the explorer's word.
// For a witness transaction: its merkle proof leads to the merkle root of a
// block header; that header's BLAKE2b proof of work meets its target and
// commits to its height; each header after it links to the one before, with
// valid work, up to the tip; and the tip agrees with the chain tip the
// publisher signs on Nostr (NIP-333), when relays answer. The explorer only
// supplies data: a wrong header, proof or link fails here.
import { hashHeaderV2 } from 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@b8cbf6337c7450fe14ddc5bce00c7280059aab5d/codec/pow/knots-header-v2.js'
import { schnorr, sha256 } from './deps.js'
import { bytesToHex, concat, hexToBytes } from './bytes.js'
import * as chain from './esplora.js'

// testnet4's proof-of-work limit, which the BLAKE2b fork keeps
const POW_LIMIT = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn
// The NIP-333 publisher of the BLAKE2b testnet4 tip (bitcoin-blake/blaketestnode lib/params.mjs).
export const NIP333 = { d: 'tbtc4b2', pubkey: 'cccccc0a8338a4aba51691f309f2f892c6c58f655a1ec3fc30522c894c166d9c', relays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev'] }
const MAX_HEADERS = 30 // confirmations counted header by header, then "30 or more"

/** A 164-byte v2 header (hex) as the schema's hasher reads it: hashes in display order. */
export function parseHeader (hex) {
  const b = hexToBytes(hex)
  if (b.length !== 164) throw new Error(`not a v2 header (${b.length} bytes)`)
  const v = new DataView(b.buffer)
  let o = 0
  const u32 = () => { const x = v.getUint32(o, true); o += 4; return x }
  const take = n => b.slice(o, o += n)
  const hash = () => bytesToHex(take(32).reverse())
  const h = { version: u32(), prevBlockHash: hash(), merkleRoot: hash(), timeOnWire: u32(), bits: u32(), nonce: u32(), nonce2: u32(), nonce3: u32(), extranonce: bytesToHex(take(16)), timeOffset: u32() }
  h.txCount = v.getUint16(o, true); o += 2
  h.flags = b[o++]
  h.xorKeyMaskClearBits = b[o++]
  h.xorKey = bytesToHex(take(16))
  h.height = v.getInt32(o, true); o += 4
  h.mmRhs = hash()
  if (!((h.version >>> 0) & 0x80000000)) throw new Error('not a v2 header')
  return h
}

export const blockHash = h => hashHeaderV2(h)

export function target (bits) {
  const exp = bits >>> 24
  const mant = BigInt(bits & 0x7fffff)
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3))
}

/** The header's hash meets the target its bits state, and that target is within the network's limit. */
export function powOk (h, hash = blockHash(h)) {
  const t = target(h.bits)
  return t > 0n && t <= POW_LIMIT && BigInt('0x' + hash) <= t
}

const dsha = b => sha256(sha256(b))

/** The merkle root (display hex) a txid and an Esplora merkle proof lead to. */
export function merkleRoot (txid, merkle, pos) {
  let cur = hexToBytes(txid).reverse()
  for (const sibling of merkle) {
    const s = hexToBytes(sibling).reverse()
    cur = pos & 1 ? dsha(concat(s, cur)) : dsha(concat(cur, s))
    pos >>= 1
  }
  return bytesToHex(cur.reverse())
}

const headers = new Map() // height -> { hash, header }, for this page's life

async function headerAt (height) {
  if (headers.has(height)) return headers.get(height)
  const claimed = await chain.blockHashAt(height)
  const h = parseHeader(await chain.headerHex(claimed))
  const hash = blockHash(h)
  if (hash !== claimed) throw new Error(`the header served for block ${height} hashes to ${hash.slice(0, 16)}…, not ${claimed.slice(0, 16)}…`)
  if (h.height !== height) throw new Error(`the header served for block ${height} commits to height ${h.height}`)
  if (!powOk(h, hash)) throw new Error(`block ${height}'s header doesn't meet its proof-of-work target`)
  const entry = { hash, header: h }
  headers.set(height, entry)
  return entry
}

/** The newest chain tip the NIP-333 publisher signed, with a verified signature: { height, hash } or null. */
export async function signedTip ({ timeoutMs = 6000 } = {}) {
  let best = null
  await Promise.all(NIP333.relays.map(url => new Promise(resolve => {
    let ws
    const done = () => { try { ws?.close() } catch {} resolve() }
    const timer = setTimeout(done, timeoutMs)
    try { ws = new WebSocket(url) } catch { clearTimeout(timer); return resolve() }
    ws.onerror = () => { clearTimeout(timer); done() }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'tip', { kinds: [33333], authors: [NIP333.pubkey], '#d': [NIP333.d], limit: 3 }]))
    ws.onmessage = m => {
      try {
        const msg = JSON.parse(m.data)
        if (msg[0] === 'EOSE') { clearTimeout(timer); return done() }
        if (msg[0] !== 'EVENT') return
        const ev = msg[2]
        if (ev.pubkey !== NIP333.pubkey || ev.created_at > Date.now() / 1000 + 600) return
        const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))))
        if (id !== ev.id || !schnorr.verify(hexToBytes(ev.sig), hexToBytes(id), hexToBytes(ev.pubkey))) return
        const height = Number(ev.tags.find(t => t[0] === 'tip')?.[1])
        const last = parseHeader(ev.content.slice(-328))
        if (last.height !== height || !powOk(last)) return
        if (!best || ev.created_at > best.created_at) best = { height, hash: blockHash(last), created_at: ev.created_at, relay: url }
      } catch {}
    }
  })))
  return best
}

/**
 * Checks that `txid` is mined, header by header, from its block up to the
 * tip the explorer reports. Resolves to { txid, state, height, confirmations,
 * more } where state is 'verified', 'mempool' or 'not-found', and `more`
 * says confirmations were counted up to MAX_HEADERS. Throws if any header,
 * proof or link fails: that's the explorer giving a wrong answer.
 */
export async function verifyMined (txid, tipHeight) {
  let proof
  try { proof = await chain.merkleProof(txid) } catch {
    const known = await chain.txStatus(txid).catch(() => null)
    return { txid, state: known ? 'mempool' : 'not-found', height: null, confirmations: 0 }
  }
  const first = await headerAt(proof.block_height)
  if (merkleRoot(txid, proof.merkle, proof.pos) !== first.header.merkleRoot) throw new Error(`the merkle proof for ${txid.slice(0, 12)}… doesn't lead to block ${proof.block_height}'s merkle root`)
  const last = Math.min(tipHeight, proof.block_height + MAX_HEADERS - 1)
  let prev = first
  for (let h = proof.block_height + 1; h <= last; h++) {
    const next = await headerAt(h)
    if (next.header.prevBlockHash !== prev.hash) throw new Error(`block ${h} doesn't link to block ${h - 1}`)
    prev = next
  }
  return { txid, state: 'verified', height: proof.block_height, confirmations: last - proof.block_height + 1, more: last < tipHeight, tip: { height: last, hash: prev.hash } }
}

/** Whether the explorer's chain agrees with the signed tip at the height both have. */
export async function agreesWithSignedTip (signed) {
  if (!signed) return null
  const mine = await headerAt(signed.height).catch(() => null)
  return mine ? mine.hash === signed.hash : null
}
