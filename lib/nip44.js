// NIP-44 version 2 encryption (https://github.com/nostr-protocol/nips/blob/master/44.md),
// tested against the spec's own vectors in test.html.
import { chacha20, hkdfExpand, hkdfExtract, hmac, secp256k1, sha256 } from './deps.js'
import { concat, fromBase64, hexToBytes, toBase64 } from './bytes.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The shared key between a secret key and another's x-only public key (hex). */
export function conversationKey (secret, pubkeyHex) {
  const shared = secp256k1.getSharedSecret(secret, hexToBytes('02' + pubkeyHex)).subarray(1, 33)
  return hkdfExtract(sha256, shared, enc.encode('nip44-v2'))
}

function messageKeys (key, nonce) {
  const k = hkdfExpand(sha256, key, nonce, 76)
  return { chachaKey: k.subarray(0, 32), chachaNonce: k.subarray(32, 44), hmacKey: k.subarray(44, 76) }
}

export function paddedLength (len) {
  if (len <= 32) return 32
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((len - 1) / chunk) + 1)
}

function pad (text) {
  const u = enc.encode(text)
  if (u.length < 1 || u.length > 65535) throw new Error('NIP-44 plaintext must be 1 to 65535 bytes')
  const out = new Uint8Array(2 + paddedLength(u.length))
  new DataView(out.buffer).setUint16(0, u.length)
  out.set(u, 2)
  return out
}

function unpad (padded) {
  const len = new DataView(padded.buffer, padded.byteOffset).getUint16(0)
  if (len === 0 || padded.length !== 2 + paddedLength(len)) throw new Error('invalid padding')
  return dec.decode(padded.subarray(2, 2 + len))
}

export function encrypt (plaintext, key, nonce = crypto.getRandomValues(new Uint8Array(32))) {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(key, nonce)
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext))
  const mac = hmac(sha256, hmacKey, concat(nonce, ciphertext))
  return toBase64(concat(Uint8Array.of(2), nonce, ciphertext, mac))
}

export function decrypt (payload, key) {
  if (!payload || payload[0] === '#') throw new Error('unknown encryption version')
  const data = fromBase64(payload)
  if (data.length < 99 || data.length > 65603 || data[0] !== 2) throw new Error('not a NIP-44 v2 payload')
  const nonce = data.subarray(1, 33)
  const ciphertext = data.subarray(33, -32)
  const mac = data.subarray(-32)
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(key, nonce)
  const expect = hmac(sha256, hmacKey, concat(nonce, ciphertext))
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= expect[i] ^ mac[i]
  if (diff) throw new Error('invalid MAC')
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext))
}
