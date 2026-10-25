// The chain, as an Esplora API serves it: coins, transactions, broadcast.
// mempool.guide is the BLAKE2b chain's explorer. ?api=<url> overrides it.
export const DEFAULT_API = 'https://mempool.guide/testnet4/api'

export function apiBase () {
  try {
    const q = new URLSearchParams(location.search).get('api')
    if (q === 'reset') localStorage.removeItem('bunting-api')
    else if (q) localStorage.setItem('bunting-api', q.replace(/\/+$/, ''))
    return localStorage.getItem('bunting-api') || DEFAULT_API
  } catch { return DEFAULT_API }
}

async function get (path, as = 'json') {
  const res = await fetch(apiBase() + path)
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 120)}`)
  return as === 'json' ? res.json() : res.text()
}

export const utxos = address => get(`/address/${address}/utxo`)
export const txHex = id => get(`/tx/${id}/hex`, 'text')
export const tip = () => get('/blocks/tip/height', 'text').then(Number)
export const explorer = path => apiBase().replace(/\/api$/, '') + path

export async function broadcast (hex) {
  const res = await fetch(apiBase() + '/tx', { method: 'POST', body: hex })
  const text = await res.text()
  if (!res.ok) throw new Error(`the server refused the transaction: ${text.slice(0, 200)}`)
  return text.trim()
}
