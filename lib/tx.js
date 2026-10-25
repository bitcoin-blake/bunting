// Bitcoin transactions: parse, serialize, and sign taproot key-path inputs
// with the BIP341 default sighash. The BLAKE2b chain changes block headers
// and proof of work, not transactions, so these are Bitcoin's own rules.
import { schnorr, sha256 } from './deps.js'
import { bytesToHex, concat, hexToBytes, le32, le64, varint } from './bytes.js'
import { outputKey, taggedHash } from './keys.js'

export function parseTx (hex) {
  const b = hexToBytes(hex)
  let o = 0
  const need = n => { if (o + n > b.length) throw new Error('truncated transaction'); return n }
  const take = n => b.slice(o, o += need(n))
  const u32 = () => new DataView(take(4).buffer).getUint32(0, true)
  const vi = () => {
    const f = take(1)[0]
    if (f < 0xfd) return f
    if (f === 0xfd) return new DataView(take(2).buffer).getUint16(0, true)
    if (f === 0xfe) return u32()
    throw new Error('oversized count')
  }
  const version = u32()
  const segwit = b[o] === 0 && b[o + 1] === 1
  if (segwit) o += 2
  const ins = Array.from({ length: vi() }, () => ({ txid: take(32), vout: u32(), script: take(vi()), sequence: u32(), witness: [] }))
  const outs = Array.from({ length: vi() }, () => ({ value: take(8), script: take(vi()) }))
  if (segwit) for (const i of ins) i.witness = Array.from({ length: vi() }, () => take(vi()))
  const locktime = u32()
  if (o !== b.length) throw new Error('trailing bytes after the transaction')
  return { version, ins, outs, locktime }
}

export function serializeTx (tx, { witness = true } = {}) {
  const hasWitness = witness && tx.ins.some(i => i.witness.length)
  return concat(
    le32(tx.version),
    hasWitness ? Uint8Array.of(0, 1) : new Uint8Array(0),
    varint(tx.ins.length),
    ...tx.ins.flatMap(i => [i.txid, le32(i.vout), varint(i.script.length), i.script, le32(i.sequence)]),
    varint(tx.outs.length),
    ...tx.outs.flatMap(o => [o.value, varint(o.script.length), o.script]),
    ...(hasWitness ? tx.ins.flatMap(i => [varint(i.witness.length), ...i.witness.flatMap(w => [varint(w.length), w])]) : []),
    le32(tx.locktime)
  )
}

const dsha = b => sha256(sha256(b))
export const txid = tx => bytesToHex(dsha(serializeTx(tx, { witness: false })).reverse())
export const outpointOf = input => `${bytesToHex(input.txid.slice().reverse())}:${input.vout}`

/** BIP341 signature message, SIGHASH_DEFAULT, key path, no annex. */
export function taprootSighash (tx, index, prevouts) {
  const sha = parts => sha256(concat(...parts))
  const msg = concat(
    Uint8Array.of(0x00, 0x00), // epoch, hash type
    le32(tx.version),
    le32(tx.locktime),
    sha(tx.ins.flatMap(i => [i.txid, le32(i.vout)])),
    sha(prevouts.map(p => le64(p.sats))),
    sha(prevouts.flatMap(p => [varint(p.script.length), p.script])),
    sha(tx.ins.map(i => le32(i.sequence))),
    sha(tx.outs.flatMap(o => [o.value, varint(o.script.length), o.script])),
    Uint8Array.of(0x00), // spend type: key path, no annex
    le32(index)
  )
  return taggedHash('TapSighash', msg)
}

/**
 * Signs every input of `hex`. `coins` maps each spent outpoint to
 * { sats, script (hex), key (tweaked secret) }. Refuses unless each key is
 * the one its script pays to, and checks each signature before returning
 * the signed transaction as hex.
 */
export function signTx (hex, coins) {
  const tx = parseTx(hex)
  const prevouts = tx.ins.map(i => {
    const c = coins[outpointOf(i)]
    if (!c) throw new Error(`no key for input ${outpointOf(i)}`)
    const script = hexToBytes(c.script)
    if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) throw new Error(`${outpointOf(i)} is not a taproot output`)
    if (bytesToHex(outputKey(c.key)) !== bytesToHex(script.slice(2))) throw new Error(`the key for ${outpointOf(i)} doesn't match its output`)
    return { sats: c.sats, script, key: c.key }
  })
  tx.ins.forEach((input, n) => {
    const msg = taprootSighash(tx, n, prevouts)
    const sig = schnorr.sign(msg, prevouts[n].key, crypto.getRandomValues(new Uint8Array(32)))
    if (!schnorr.verify(sig, msg, prevouts[n].script.slice(2))) throw new Error('a signature did not verify')
    input.witness = [sig]
  })
  return bytesToHex(serializeTx(tx))
}

/**
 * An unsigned version-2 transaction spending `inputs` ([{ outpoint }]) to
 * `outputs` ([{ script (hex), sats }]), each input signalling replaceability.
 */
export function buildTx (inputs, outputs) {
  return bytesToHex(serializeTx({
    version: 2,
    locktime: 0,
    ins: inputs.map(c => {
      const [id, vout] = c.outpoint.split(':')
      return { txid: hexToBytes(id).reverse(), vout: Number(vout), script: new Uint8Array(0), sequence: 0xfffffffd, witness: [] }
    }),
    outs: outputs.map(o => ({ value: le64(o.sats), script: hexToBytes(o.script) }))
  }))
}

/** Virtual size of a transaction spending taproot key-path inputs to outputs with these scripts (hex). */
export const vsizeOf = (nIn, outScripts) => Math.ceil(10.5 + 57.5 * nIn + outScripts.reduce((n, s) => n + 9 + s.length / 2, 0))
