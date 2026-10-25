// Checking "is it mined?" in this tab instead of taking the explorer's word.
// For a witness transaction: its merkle proof leads to the merkle root of a
// block header; that header's BLAKE2b proof of work meets its target and
// commits to its height; each header after it links to the one before, with
// valid work, up to the tip; and the tip agrees with the chain tip the
// publisher signs on Nostr (NIP-333), when relays answer. The explorer only
// supplies data: a wrong header, proof or link fails here.
import { hashHeaderV2, headerTime } from 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@b8cbf6337c7450fe14ddc5bce00c7280059aab5d/codec/pow/knots-header-v2.js'
import { schnorr, sha256 } from './deps.js'
import { bytesToHex, concat, hexToBytes } from './bytes.js'
import * as chain from './esplora.js'

// testnet4's proof-of-work limit, which the BLAKE2b fork keeps
const POW_LIMIT = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn
// The NIP-333 publisher of the BLAKE2b testnet4 tip (bitcoin-blake/blaketestnode lib/params.mjs).
export const NIP333 = { d: 'tbtc4b2', pubkey: 'cccccc0a8338a4aba51691f309f2f892c6c58f655a1ec3fc30522c894c166d9c', relays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.nostr.band', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev'] }
// A signed tip older than this says little about today's chain (a block
// comes about every 20 minutes): it is shown, but nothing is anchored to it.
export const STALE_S = 6 * 3600
const MAX_HEADERS = 30 // confirmations counted header by header, then "30 or more"
const MAX_TO_SIGNED = 300 // headers walked to reach the signed tip
// testnet4's difficulty rules, which the fork keeps (schema chain.jsonld,
// overlays/knots-blake2b.jsonld): 2016-block periods retargeted from the
// period's first block (BIP 94), and the 20-minute minimum-difficulty exception.
const INTERVAL = 2016
const SPACING = 600
const TIMESPAN = 1209600
const MAX_FUTURE = 7200
const POW_BITS = 0x1d00ffff
const TARGET_SHIFTS = { 150308: 20 } // the fork's first BLAKE2b block eased its target by 2^20

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
  h.time = headerTime(h) // the consensus time: the wire time, plus the offset when flagged
  return h
}

export const blockHash = h => hashHeaderV2(h)

// Bitcoin Core's GetCompact, as schema codec/headers.js compactFromTarget.
export function compact (target) {
  let size = Math.ceil(target.toString(16).length / 2)
  let c = size <= 3 ? Number(target << (8n * BigInt(3 - size))) : Number(target >> (8n * BigInt(size - 3)))
  if (c & 0x800000) { c >>= 8; size++ }
  return (c | (size << 24)) >>> 0
}

function adjustAt (height, bits) {
  const shift = TARGET_SHIFTS[height]
  if (!shift) return bits
  const t = target(bits)
  return compact(t > (POW_LIMIT >> BigInt(shift)) ? POW_LIMIT : t << BigInt(shift))
}

function retarget (firstTime, lastTime, baseBits) {
  const actual = Math.max(TIMESPAN / 4, Math.min(lastTime - firstTime, TIMESPAN * 4))
  let t = target(baseBits) * BigInt(actual) / BigInt(TIMESPAN)
  if (t > POW_LIMIT) t = POW_LIMIT
  return compact(t)
}

/**
 * The bits a header at `height` must carry, after `prev`. Inside a period:
 * the minimum difficulty when it comes more than 20 minutes after `prev`,
 * otherwise the period's difficulty, set by its first block (`periodFirst`),
 * which is what Core's walk-back reaches when the period is valid. At a period
 * boundary: retargeted from the last period's span, based on its first block's
 * bits (BIP 94).
 */
export function expectedBits (height, header, prev, periodFirst) {
  if (height % INTERVAL !== 0) {
    if (header.time > prev.time + 2 * SPACING) return POW_BITS
    return adjustAt(height, periodFirst.bits)
  }
  return adjustAt(height, retarget(periodFirst.time, prev.time, periodFirst.bits))
}

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
  if (h.time > Date.now() / 1000 + MAX_FUTURE) throw new Error(`block ${height}'s time is more than two hours ahead`)
  const entry = { hash, header: h }
  headers.set(height, entry)
  return entry
}

/** The newest chain tip the NIP-333 publisher signed, with a verified signature: { height, hash } or null. */
export async function signedTip ({ timeoutMs = 10000 } = {}) {
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
        if (!best || ev.created_at > best.created_at) best = { height, hash: blockHash(last), created_at: ev.created_at, relay: url, stale: Date.now() / 1000 - ev.created_at > STALE_S }
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
export async function verifyMined (txid, tipHeight, signed = null) {
  let proof
  try { proof = await chain.merkleProof(txid) } catch {
    const known = await chain.txStatus(txid).catch(() => null)
    return { txid, state: known ? 'mempool' : 'not-found', height: null, confirmations: 0 }
  }
  const start = proof.block_height
  const first = await headerAt(start)
  if (merkleRoot(txid, proof.merkle, proof.pos) !== first.header.merkleRoot) throw new Error(`the merkle proof for ${txid.slice(0, 12)}… doesn't lead to block ${start}'s merkle root`)
  // Walk up to the tip (counting up to MAX_HEADERS), and on to the signed tip
  // if it is higher, checking every link and every header's difficulty.
  const reachSigned = signed && !signed.stale && signed.height >= start && signed.height - start < MAX_TO_SIGNED ? signed.height : -1
  // The signed tip's height, not the explorer's word, decides how far the walk
  // must go: an explorer that under-reports its tip can't stop it short.
  const last = Math.max(Math.min(tipHeight, start + MAX_HEADERS - 1), reachSigned)
  const periodFirst = async h => (await headerAt(h - (h % INTERVAL) - (h % INTERVAL === 0 ? INTERVAL : 0))).header
  let prev = await headerAt(start - 1)
  let anchored = null
  for (let h = start; h <= last; h++) {
    const cur = h === start ? first : await headerAt(h)
    if (cur.header.prevBlockHash !== prev.hash) throw new Error(`block ${h} doesn't link to block ${h - 1}`)
    const want = expectedBits(h, cur.header, prev.header, await periodFirst(h))
    if (cur.header.bits !== want) throw new Error(`block ${h} has difficulty bits ${cur.header.bits.toString(16)}, the rules require ${want.toString(16)}`)
    if (h === reachSigned) anchored = cur.hash === signed.hash
    prev = cur
  }
  // Only headers walked and checked count as confirmations.
  return { txid, state: 'verified', height: start, confirmations: last - start + 1, more: last < Math.max(tipHeight, reachSigned), anchored }
}

/** Whether the explorer's chain agrees with the signed tip at the height both have. */
export async function agreesWithSignedTip (signed) {
  if (!signed) return null
  const mine = await headerAt(signed.height).catch(() => null)
  return mine ? mine.hash === signed.hash : null
}
