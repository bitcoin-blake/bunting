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
/** Coins paying to a script (hex), for outputs with no plain wallet address. */
export const scriptUtxos = scriptHash => get(`/scripthash/${scriptHash}/utxo`)
export const txHex = id => get(`/tx/${id}/hex`, 'text')
/** A fee rate (sat/vB) for confirming within about `blocks` blocks; at least 1. */
export const feeRate = async (blocks = 2) => Math.max(1, (await get('/fee-estimates'))[blocks] ?? 1)
export const txStatus = id => get(`/tx/${id}/status`)
export const merkleProof = id => get(`/tx/${id}/merkle-proof`)
export const blockHashAt = height => get(`/block-height/${height}`, 'text').then(s => s.trim())
export const headerHex = hash => get(`/block/${hash}/header`, 'text').then(s => s.trim())
export const tip = () => get('/blocks/tip/height', 'text').then(Number)
export const explorer = path => apiBase().replace(/\/api$/, '') + path

export async function broadcast (hex) {
  const res = await fetch(apiBase() + '/tx', { method: 'POST', body: hex })
  const text = await res.text()
  if (!res.ok) throw new Error(`the server refused the transaction: ${text.slice(0, 200)}`)
  return text.trim()
}
