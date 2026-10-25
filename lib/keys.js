// One random seed kept in this tab gives everything: a BIP86 taproot account
// (m/86'/1'/0') whose tpub rgbjs uses to build payments, the keys that sign
// them, and the RGB noise seed that blinds this wallet's seals and invoices.
import { HDKey, schnorr, secp256k1, sha256 } from './deps.js'
import { bigToBytes, bytesToBig, concat } from './bytes.js'

const TESTNET = { private: 0x04358394, public: 0x043587cf } // tprv / tpub
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export const taggedHash = (tag, ...msg) => {
  const t = sha256(new TextEncoder().encode(tag))
  return sha256(concat(t, t, ...msg))
}

export function wallet (seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('the wallet seed must be 32 bytes')
  const master = HDKey.fromMasterSeed(seed, TESTNET)
  const account = master.derive("m/86'/1'/0'")
  const fp = master.fingerprint.toString(16).padStart(8, '0')
  return {
    // rgbjs's descriptor: origin, account tpub, receive and change keychains
    descriptor: `[${fp}/86h/1h/0h]${account.publicExtendedKey}/<0;1>/*`,
    noiseSeed: sha256(concat(new TextEncoder().encode('bunting rgb noise'), seed)),
    /** The BIP86-tweaked secret key for a terminal such as `&0/3`. */
    signingKey (terminal) {
      const m = /^&(\d+)\/(\d+)$/.exec(terminal)
      if (!m) throw new Error(`not a terminal: ${terminal}`)
      return tweak(account.deriveChild(Number(m[1])).deriveChild(Number(m[2])).privateKey)
    }
  }
}

/** Taproot key-path tweak (BIP341); BIP86 has no script tree. */
export function tweak (secret, merkleRoot = new Uint8Array(0)) {
  let d = bytesToBig(secret)
  if (secp256k1.getPublicKey(secret, true)[0] === 3) d = N - d // use the even-y key
  const t = bytesToBig(taggedHash('TapTweak', schnorr.getPublicKey(secret), merkleRoot))
  if (t >= N) throw new Error('tweak out of range')
  return bigToBytes((d + t) % N)
}

/** The x-only output key of a tweaked secret: bytes 2..34 of its P2TR scriptPubKey. */
export const outputKey = secret => schnorr.getPublicKey(secret)
