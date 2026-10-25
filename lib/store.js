// What the tab keeps, in localStorage. Test coins only: the seed is stored
// as it is, like Reef's one key. Back it up from the wallet's settings.
const KEY = 'bunting-v1'

// tapret: { [scriptPubkey hex]: { terminal, merkleRoot } } for RGB change coins
const empty = () => ({ seed: null, contracts: {}, seals: [], nonce: 0, sent: [], tapret: {} })

export function load () {
  try { return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return empty() }
}

export function save (state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) { throw new Error(`this browser won't store the wallet: ${e.message}`) }
}

export function wipe () {
  try { localStorage.removeItem(KEY) } catch {}
}
