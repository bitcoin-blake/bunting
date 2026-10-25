// A whole-wallet backup: the seed and the asset backup in one file, encrypted
// with a passphrase. PBKDF2-SHA256 (600,000 iterations) makes an AES-256-GCM
// key, all with the browser's own WebCrypto.
import { fromBase64, toBase64 } from './bytes.js'

export const ITERATIONS = 600000

async function keyFrom (passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Encrypts `contents` (an object) into a backup object to save as JSON. */
export async function seal (contents, passphrase, { iterations = ITERATIONS } = {}) {
  if (!passphrase || passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFrom(passphrase, salt, iterations)
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(contents))))
  return { kind: 'bunting-wallet', version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) }, cipher: { name: 'AES-GCM', iv: toBase64(iv) }, data: toBase64(data) }
}

/** Decrypts a backup object; throws on a wrong passphrase or a damaged file. */
export async function open (backup, passphrase) {
  if (backup?.kind !== 'bunting-wallet' || backup.version !== 1) throw new Error('This isn\'t a Bunting wallet backup.')
  const { iterations, salt } = backup.kdf
  if (!(iterations >= 100000)) throw new Error('This backup\'s key derivation is too weak to trust.')
  const key = await keyFrom(passphrase, fromBase64(salt), iterations)
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(backup.cipher.iv) }, key, fromBase64(backup.data))
    return JSON.parse(new TextDecoder().decode(plain))
  } catch { throw new Error('Wrong passphrase, or the file is damaged.') }
}
