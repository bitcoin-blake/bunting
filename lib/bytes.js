export const hexToBytes = h => {
  if (typeof h !== 'string' || h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('not hex')
  return Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16))
}
export const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
export const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
export const le64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b }
export const varint = n => n < 0xfd ? Uint8Array.of(n) : n <= 0xffff ? Uint8Array.of(0xfd, n & 0xff, n >> 8) : concat(Uint8Array.of(0xfe), le32(n))
// In chunks: spreading a large array into one call overflows the stack.
export const toBase64 = b => {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
export const fromBase64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
export const bytesToBig = b => BigInt('0x' + (bytesToHex(b) || '0'))
export const bigToBytes = n => hexToBytes(n.toString(16).padStart(64, '0'))
