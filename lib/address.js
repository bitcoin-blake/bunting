// Segwit addresses (BIP173 bech32, BIP350 bech32m) to scriptPubKeys, for
// sending to any testnet address: `tb` on testnet4 and the BLAKE2b chain.
import { bytesToHex } from './bytes.js'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32 = 1
const BECH32M = 0x2bc830a3

function polymod (values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]
  }
  return chk >>> 0
}

const expand = hrp => [...hrp].map(c => c.charCodeAt(0) >> 5).concat(0, [...hrp].map(c => c.charCodeAt(0) & 31))

function convert (data, from, to) {
  let acc = 0
  let bits = 0
  const out = []
  for (const v of data) {
    acc = (acc << from) | v
    bits += from
    while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)) }
  }
  if (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1))) throw new Error('bad padding')
  return out
}

/** The scriptPubKey (hex) of a segwit address on the `hrp` network. */
export function addressScript (address, hrp = 'tb') {
  const a = address.trim()
  if (a !== a.toLowerCase() && a !== a.toUpperCase()) throw new Error('mixed case address')
  const s = a.toLowerCase()
  const pos = s.lastIndexOf('1')
  if (pos < 1 || s.length > 90 || s.length - pos < 7) throw new Error('not a segwit address')
  if (s.slice(0, pos) !== hrp) throw new Error(`not a ${hrp} address (this is ${s.slice(0, pos)})`)
  const data = [...s.slice(pos + 1)].map(c => { const i = CHARSET.indexOf(c); if (i < 0) throw new Error('bad character'); return i })
  const check = polymod(expand(hrp).concat(data))
  const version = data[0]
  if (check !== (version === 0 ? BECH32 : BECH32M)) throw new Error('bad checksum: check the address')
  const program = convert(data.slice(1, -6), 5, 8)
  if (version > 16 || program.length < 2 || program.length > 40) throw new Error('bad witness program')
  if (version === 0 && program.length !== 20 && program.length !== 32) throw new Error('bad witness program')
  if (version === 1 && program.length !== 32) throw new Error('a taproot address has a 32-byte program')
  const op = version === 0 ? 0 : 0x50 + version
  return bytesToHex(Uint8Array.of(op, program.length, ...program))
}
