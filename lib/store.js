// What the tab keeps, in localStorage. Test coins only: the seed is stored
// as it is, like Reef's one key. Back it up from the wallet's settings.
// ?wallet=<name> keeps a separate wallet in the same browser (say, to pay
// yourself across two wallets, or to keep test runs apart).
export const WALLET = (() => {
  try {
    const name = new URLSearchParams(location.search).get('wallet')
    return name && /^[a-z0-9-]{1,20}$/.test(name) ? name : ''
  } catch { return '' }
})()
const KEY = WALLET ? `bunting-v1:${WALLET}` : 'bunting-v1'

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
