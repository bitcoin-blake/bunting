// Bunting: the wallet page. RGB comes from rgbjs; keys, signing and the
// chain are in ./lib. Every asset file and invoice secret stays in this tab.
import * as rgbjs from 'https://rgbjs.com/src/index.js'
import { fromBase64, hexToBytes, bytesToHex, toBase64 } from './lib/bytes.js'
import { sha256 } from './lib/deps.js'
import * as chain from './lib/esplora.js'
import { wallet } from './lib/keys.js'
import { parentTxEvent, publish } from './lib/nostr.js'
import { WALLET, load, save, wipe } from './lib/store.js'
import { addressScript } from './lib/address.js'
import { agreesWithSignedTip, signedTip, verifyMined } from './lib/spv.js'
import { buildTx, outpointOf, parseTx, signTx, txid as txidOf, vsizeOf } from './lib/tx.js'

const { v012 } = rgbjs
const $ = s => document.querySelector(s)
// Receive keychain &0 and change keychain &1; rgbjs puts payment change on &1/0.
// &0/5.. hold spare coins from splits, &1/1 the change of plain sends.
const TERMINALS = [...Array(10).keys()].map(i => `&0/${i}`).concat(['&1/0', '&1/1', '&1/2', '&1/3'])
const PLAIN_CHANGE = '&1/1'
const SPARE = ['&0/5', '&0/6', '&0/7', '&0/8', '&0/9']
const DUST = 330
// The trusted issuers rgbjs knows: RGB20 fungible tokens and RGB25 assets.
const ISSUERS = {
  FNA: { codexId: '7C15w3W1-L0T~zXw-Aeh5~kV-Zquz729-HXQFKQW-_5lX9O8', version: 0, checksum: 'AYkSrg' },
  UFA: { codexId: 'mqmGvodN-WxpxyRb-RsGHiTQ-jDoRvMy-ClhrQGx-FMa5Cpw', version: 0, checksum: 'aiRB3w' }
}
const PRECISION = { 0: 'indivisible', 2: 'centi', 8: 'centiMicro' }
const MIN_SATS = 1000 // a coin carrying an asset also pays the fee of spending it

let state = load()
let w = null
let coins = [] // [{ outpoint, sats, terminal, address, script, confirmed }]
let holdings = new Map() // contractId -> { summary, cells: [{ outpoint, name, value }], witnesses }

function el (tag, attrs = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v)
  }
  e.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false))
  return e
}
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter(k => k !== null && k !== undefined && k !== false))
const note = (kind, ...text) => el('div', { class: `msg ${kind}` }, ...text)
const short = s => `${s.slice(0, 10)}…${s.slice(-6)}`
const link = (path, text) => el('a', { href: chain.explorer(path), target: '_blank', rel: 'noopener' }, text)
const files = id => (state.contracts[id]?.files ?? []).map(fromBase64)
const persist = () => save(state)

function guard (out, fn) {
  return async (...a) => {
    try { await fn(...a) } catch (e) { console.error(e); $(out).replaceChildren(note('bad', e.message)) }
  }
}

function download (bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const a = el('a', { href: url, download: name })
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

// Links carry data in the query string (or after #, which stays in the
// browser): ?pay=<invoice> fills in Pay, ?transfer=<gzip, base64url> takes a
// transfer in. ?wallet= is kept, so a link can target a named wallet.
const b64url = b => toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = s => fromBase64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4))
const gzip = async b => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
const gunzip = async b => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
// Pay links use the query string; transfer links put their data after #, so
// the payment history in them never reaches the web server.
const linkTo = (key, value, hash = false) => `${location.origin}${location.pathname}${hash ? '#' : '?'}${key}=${value}`

/** The ways to hand a transfer file to its payee: a link to open, or the file. */
function handOver (bytes, name) {
  return el('div', { class: 'row' },
    el('button', { onclick: async e => copy(linkTo('transfer', b64url(await gzip(bytes)), true), e.target) }, 'Copy a link to it'),
    el('button', { class: 'quiet', onclick: () => download(bytes, name) }, 'Download the file'))
}

async function copy (text, button) {
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied' } catch { button.textContent = 'Select and copy it' }
}

// ---- setup -------------------------------------------------------------

if (WALLET) {
  $('#wallet-name').hidden = false
  $('#wallet-name').replaceChildren(`Wallet “${WALLET}” · `, el('a', { href: location.pathname }, 'the main wallet'))
  document.title = `Bunting · ${WALLET}`
}

function start () {
  if (!state.seed) { $('#setup').hidden = false; return }
  w = wallet(hexToBytes(state.seed))
  $('#setup').hidden = true
  $('#main').hidden = false
  $('#address').textContent = v012.deriveAddress(w.descriptor, '&0/0').address
  $('#api').textContent = chain.apiBase()
  refresh().then(openLink)
}

window.addEventListener('hashchange', () => { if (w) openLink() })

async function openLink () {
  const q = new URLSearchParams(location.search)
  const h = new URLSearchParams(location.hash.slice(1))
  const pay = q.get('pay') ?? h.get('pay')
  const transfer = q.get('transfer') ?? h.get('transfer')
  if (!pay && !transfer) return
  // Forget the link once read, keeping ?wallet, so a reload doesn't repeat it.
  const keep = new URLSearchParams()
  if (q.get('wallet')) keep.set('wallet', q.get('wallet'))
  history.replaceState(null, '', location.pathname + (keep.size ? `?${keep}` : ''))
  if (pay) {
    $('#p-invoice').value = pay
    $('#pay-card').scrollIntoView({ block: 'start' })
    $('#pay-out').replaceChildren(note('', 'Opened from a pay link. Check the invoice, then build the payment.'))
  }
  if (transfer) {
    $('#receive-card').scrollIntoView({ block: 'start' })
    await guard('#accept-out', async () => takeIn(await gunzip(fromB64url(transfer))))()
  }
}

$('#create').addEventListener('click', () => {
  state = { ...load(), seed: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }
  persist(); start()
})
$('#restore').addEventListener('click', () => {
  const seed = $('#restore-seed').value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(seed)) { $('#restore-seed').setCustomValidity('64 hex characters'); $('#restore-seed').reportValidity(); return }
  state = { ...load(), seed }
  persist(); start()
})

// ---- coins and holdings ------------------------------------------------

async function scanCoins () {
  const found = []
  await Promise.all(TERMINALS.map(async terminal => {
    const { address, scriptPubkey } = v012.deriveAddress(w.descriptor, terminal)
    for (const u of await chain.utxos(address)) {
      found.push({ outpoint: `${u.txid}:${u.vout}`, sats: u.value, terminal, address, script: scriptPubkey, confirmed: u.status?.confirmed ? u.status.block_height : null })
    }
  }))
  // RGB change committed with tapret pays to a tweaked key, not a plain address.
  await Promise.all(Object.entries(state.tapret ?? {}).map(async ([script, t]) => {
    for (const u of await chain.scriptUtxos(bytesToHex(sha256(hexToBytes(script))))) {
      found.push({ outpoint: `${u.txid}:${u.vout}`, sats: u.value, terminal: t.terminal, merkleRoot: t.merkleRoot, address: null, script, confirmed: u.status?.confirmed ? u.status.block_height : null })
    }
  }))
  return found.sort((a, b) => b.sats - a.sats)
}

// What this wallet holds of each asset: the cells, in any of its files, that
// sit on one of its unspent coins. Cells paid to an invoice are found from
// the invoice's secret.
function computeHoldings () {
  const mine = new Set(coins.map(c => c.outpoint))
  holdings = new Map()
  for (const id of Object.keys(state.contracts)) {
    const cells = new Map()
    let summary = null
    const witnesses = new Set()
    for (const bytes of files(id)) {
      const r = rgbjs.validateConsignment(bytes)
      if (!r.valid) continue
      summary = rgbjs.assetSummary(r)
      for (const wt of r.witnesses ?? []) witnesses.add(wt.txid)
      for (const [name, list] of Object.entries(r.state?.owned ?? {})) {
        for (const c of list) if (mine.has(c.outpoint)) cells.set(`${c.outpoint}|${name}|${c.value}`, { outpoint: c.outpoint, name, value: c.value })
      }
      for (const s of state.seals.filter(s => s.contractId === id)) {
        const got = v012.receive(bytes, { outpoint: s.outpoint, noiseSeed: w.noiseSeed, nonce: s.nonce }).receive.received
        for (const g of got) if (mine.has(g.outpoint)) cells.set(`${g.outpoint}|${g.name}|${g.value}`, { outpoint: g.outpoint, name: g.name, value: g.value })
      }
    }
    holdings.set(id, { summary, cells: [...cells.values()], witnesses: [...witnesses] })
  }
}

// A coin an invoice of yours points at, with nothing received on it yet: a
// payment may still land there, so plain sends leave it alone.
const awaited = outpoint => state.seals.some(s => s.outpoint === outpoint && !s.cancelled) && !assetsOn(outpoint).length
const plainCoins = () => coins.filter(c => !assetsOn(c.outpoint).length && !awaited(c.outpoint))
const assetsOn = outpoint => [...holdings].filter(([, h]) => h.cells.some(c => c.outpoint === outpoint)).map(([id]) => id)
const total = h => h.cells.reduce((n, c) => /^\d+$/.test(c.value) ? n + BigInt(c.value) : n, 0n)
const unit = h => h?.summary?.ticker ?? h?.summary?.name ?? 'units'
const amount = (h, raw) => h?.summary ? `${rgbjs.formatAmount(String(raw), h.summary.decimals)} ${unit(h)}` : String(raw)

async function refresh () {
  $('#refresh').disabled = true
  try {
    const [height, found, rate] = await Promise.all([chain.tip(), scanCoins(), chain.feeRate(2).catch(() => 1)])
    for (const id of ['#p-rate', '#s-rate']) if (!$(id).dataset.touched) $(id).value = String(rate)
    coins = found
    $('#chain').textContent = `txbt4 at block ${height.toLocaleString()} · ${chain.apiBase().replace(/^https:\/\//, '')}`
    computeHoldings()
    render()
    checkWitnesses()
    renderPlainSent()
  } catch (e) {
    $('#chain').textContent = `Couldn't reach the chain: ${e.message}`
  } finally { $('#refresh').disabled = false }
}
$('#refresh').addEventListener('click', refresh)
for (const id of ['#p-rate', '#s-rate']) $(id).addEventListener('input', e => { e.target.dataset.touched = '1' })
$('#copy-address').addEventListener('click', e => copy($('#address').textContent, e.target))

function render () {
  const sats = coins.reduce((n, c) => n + c.sats, 0)
  fill($('#coins'), 
    el('tr', {}, el('th', {}, 'Coin'), el('th', {}, 'tBTC'), el('th', {}, 'Status'), el('th', {}, 'Carries')),
    ...coins.map(c => el('tr', {},
      el('td', { class: 'mono' }, link(`/tx/${c.outpoint.split(':')[0]}`, short(c.outpoint))),
      el('td', {}, (c.sats / 1e8).toFixed(8)),
      el('td', {}, c.confirmed ? `block ${c.confirmed}` : 'unconfirmed'),
      el('td', {}, assetsOn(c.outpoint).map(id => { const h = holdings.get(id); return amount(h, h.cells.filter(x => x.outpoint === c.outpoint).reduce((n, x) => n + BigInt(x.value), 0n)) }).join(', ') || (awaited(c.outpoint) ? 'waiting for an invoice' : '—')))),
    coins.length ? null : el('tr', {}, el('td', { colspan: 4, class: 'small' }, 'No coins yet. Send some txbt4 to the address above, mine some in Winch, or ask someone with a txbt4 node.')),
    coins.length ? el('tr', {}, el('td', { class: 'small' }, `${coins.length} coin${coins.length === 1 ? '' : 's'}`), el('td', {}, (sats / 1e8).toFixed(8)), el('td'), el('td')) : null
  )
  const ids = Object.keys(state.contracts)
  fill($('#assets'), 
    el('tr', {}, el('th', {}, 'Asset'), el('th', {}, 'You hold'), el('th', {}, 'On chain')),
    ...ids.map(id => {
      const h = holdings.get(id)
      return el('tr', {},
        el('td', {}, el('div', {}, h?.summary ? `${h.summary.name ?? ''} (${h.summary.ticker ?? 'RGB25'})` : 'Unknown asset'), el('div', { class: 'mono small' }, id)),
        el('td', {}, amount(h, total(h ?? { cells: [] }))),
        el('td', { id: `w-${id.replace(/[^A-Za-z0-9]/g, '')}`, class: 'small' }, h?.witnesses.length ? 'checking…' : 'issued here, no transfers yet'))
    }),
    ids.length ? null : el('tr', {}, el('td', { colspan: 3, class: 'small' }, 'No assets yet. Issue one below, or make an invoice for one and take the transfer in.'))
  )
  const free = coins.filter(c => !assetsOn(c.outpoint).length && c.sats >= MIN_SATS)
  $('#i-coin').replaceChildren(...free.map(c => el('option', { value: c.outpoint }, `${short(c.outpoint)} · ${(c.sats / 1e8).toFixed(8)}`)))
  $('#issue').disabled = !free.length
  $('#sent').replaceChildren(...(state.sent.length ? [el('h3', { class: 'small' }, 'Payments made'), ...state.sent.slice().reverse().map(s => el('div', { class: 'row small' },
    el('span', { class: 'mono' }, link(`/tx/${s.txid}`, short(s.txid))), el('span', {}, s.at.slice(0, 16).replace('T', ' ')),
    state.seals.some(x => x.invoice === s.invoice) ? el('span', {}, 'to this wallet') : handOver(fromBase64(s.transfer), `bunting-${s.txid.slice(0, 8)}.transfer.rgb`)))] : []))
  $('#r-asset').replaceChildren(
    ...ids.map(id => el('option', { value: id }, holdings.get(id)?.summary ? unit(holdings.get(id)) : short(id))),
    el('option', { value: '' }, 'Another asset: paste its contract ID')
  )
  renderGuide()
  renderOpenInvoices()
}

// Confirmations are checked in this tab: merkle proof, header proof of work,
// header links up to the tip (lib/spv.js), and the tip against the one the
// publisher signs on Nostr. The explorer supplies the data, not the verdict.
// Invoices waiting on a coin that has nothing yet. Cancelling one frees the
// coin for plain sends; its secret stays, so a late payment is still seen.
function renderOpenInvoices () {
  const mine = new Set(coins.map(c => c.outpoint))
  const open = state.seals.filter(s => !s.cancelled && mine.has(s.outpoint) && !assetsOn(s.outpoint).length)
  $('#open-invoices').replaceChildren(...(open.length ? [el('h3', { class: 'small' }, 'Open invoices')] : []), ...open.map(s => {
    const h = holdings.get(s.contractId)
    return el('div', { class: 'row small' },
      el('span', {}, `${amount(h, s.value)} to coin ${short(s.outpoint)}`),
      el('button', { class: 'quiet', onclick: e => copy(s.invoice, e.target) }, 'Copy'),
      el('button', { class: 'quiet', onclick: e => copy(linkTo('pay', encodeURIComponent(s.invoice)), e.target) }, 'Pay link'),
      el('button', { class: 'quiet', onclick: () => { s.cancelled = true; persist(); render() } }, 'Cancel'))
  }))
}

// ---- getting started ----------------------------------------------------

function go (card, focus) {
  const c = $(card)
  c.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (card === '#assets-card') c.querySelector('details').open = true
  if (focus) setTimeout(() => $(focus)?.focus(), 400)
}

function renderGuide () {
  const received = [...holdings.values()].some(h => h.cells.length) && state.seals.length
  const steps = [
    [coins.length > 0, 'Get test coins',
      ['Send txbt4 to this wallet\'s address, ', el('a', { href: 'https://bitcoin-blake.github.io/winch/', target: '_blank', rel: 'noopener' }, 'mine some in Winch'), ', or ask someone with a txbt4 node.'],
      ['Copy the address', () => { copy($('#address').textContent, $('#copy-address')); go('#coins-card') }]],
    [Object.values(state.contracts).some(c => c.files.length), 'Issue an asset',
      ['A token or an RGB25 asset on one of your coins. Issuing costs nothing on chain.'],
      ['Issue', () => go('#assets-card', '#i-name')]],
    [state.seals.length > 0, 'Make an invoice',
      ['Ask for an asset, yours or someone else\'s: the payment lands on one of your coins.'],
      ['Make one', () => go('#receive-card', '#r-amount')]],
    [state.sent.length > 0 || received, 'Send or take in a payment',
      ['Pay an invoice (yours, from a second wallet with ', el('code', {}, '?wallet=bob'), ', or a friend\'s), then hand over the transfer file.'],
      ['Pay', () => go('#pay-card', '#p-invoice')]]
  ]
  const done = steps.filter(s => s[0]).length
  $('#guide').hidden = state.guideHidden || done === steps.length
  $('#guide-steps').replaceChildren(...steps.map(([ok, title, text, [label, act]], i) => el('li', { class: ok ? 'done' : '' },
    el('span', { class: 'mark', 'aria-label': ok ? 'done' : 'to do' }, ok ? '✓' : String(i + 1)),
    el('span', { class: 'what' }, el('b', {}, title), ...text),
    ok ? el('span') : el('button', { class: 'quiet', onclick: act }, label))))
}
$('#guide-hide').addEventListener('click', () => { state.guideHidden = true; persist(); $('#guide').hidden = true })

async function checkWitnesses () {
  let tipHeight
  try { tipHeight = await chain.tip() } catch { return }
  const signed = await signedTip().catch(() => null)
  for (const [id, h] of holdings) {
    const cell = document.getElementById(`w-${id.replace(/[^A-Za-z0-9]/g, '')}`)
    if (!cell || !h.witnesses.length) continue
    try {
      const r = await Promise.all(h.witnesses.map(txid => verifyMined(txid, tipHeight, signed)))
      const waiting = r.filter(x => x.state !== 'verified')
      const min = Math.min(...r.map(x => x.confirmations))
      const more = r.some(x => x.confirmations === min && x.more)
      const anchored = r.every(x => x.anchored === true)
      const off = r.some(x => x.anchored === false)
      cell.textContent = waiting.length
        ? `${waiting.length} of ${r.length} witness transaction${r.length === 1 ? '' : 's'} not mined yet`
        : off
          ? 'mined on a chain that does NOT lead to the tip signed on Nostr'
          : `every witness mined, ${min}${more ? '+' : ''} confirmation${min === 1 && !more ? '' : 's'}, checked here${anchored ? ' and part of the chain signed on Nostr' : ''}`
      if (off) cell.style.color = 'var(--bad)'
      cell.title = 'Merkle proofs, header proof of work, difficulty and links checked in this tab' + (anchored ? `, up to the tip signed on Nostr at block ${signed.height}` : '') + '; the explorer only supplied the data.'
    } catch (e) {
      cell.textContent = `the explorer's answer failed a check: ${e.message}`
      cell.style.color = 'var(--bad)'
    }
  }
  const agree = await agreesWithSignedTip(signed)
  if (signed && agree !== null) {
    $('#chain').append(agree
      ? ` · matches the tip signed on Nostr at block ${signed.height.toLocaleString()}`
      : el('span', { style: 'color: var(--bad)' }, ` · disagrees with the tip signed on Nostr at block ${signed.height.toLocaleString()}`))
  }
}

// ---- issue ---------------------------------------------------------------

$('#issue').addEventListener('click', guard('#issue-out', () => {
  const kind = $('#i-kind').value
  const ticker = $('#i-ticker').value.trim().toUpperCase()
  const name = $('#i-name').value.trim()
  const decimals = Number($('#i-precision').value)
  const whole = $('#i-supply').value.trim()
  const outpoint = $('#i-coin').value
  if (kind === 'FNA' && !/^[A-Z][A-Z0-9]{0,7}$/.test(ticker)) throw new Error('The ticker is 1 to 8 letters or digits, starting with a letter.')
  if (!name) throw new Error('Give the token a name.')
  if (!/^[1-9]\d*$/.test(whole)) throw new Error('The supply is a whole number of tokens.')
  const supply = Number(whole) * 10 ** decimals
  if (!Number.isSafeInteger(supply)) throw new Error('That supply is too large here.')
  const params = {
    consensus: 'bitcoin', testnet: true, method: 'issue', timestamp: new Date().toISOString(), issuer: ISSUERS[kind],
    name: (name.replace(/[^A-Za-z0-9_]/g, '') || 'Token').replace(/^(\d)/, 'T$1'),
    global: [
      kind === 'FNA' ? { name: 'ticker', verified: ticker } : { name: 'details', verified: null, unverified: $('#i-details').value.trim() || 'none' },
      { name: 'name', verified: name }, { name: 'precision', verified: PRECISION[decimals] }, { name: 'issued', verified: supply }],
    owned: [{ name: 'balance', seal: outpoint, data: supply }]
  }
  const bytes = v012.issueContract(params, w.noiseSeed)
  const r = rgbjs.validateConsignment(bytes)
  if (!r.valid) throw new Error(`rgbjs made a contract it doesn't accept: ${r.error}`)
  state.contracts[r.contractId] = { files: [toBase64(bytes)] }
  persist()
  computeHoldings(); render()
  $('#issue-out').replaceChildren(note('ok', `Issued ${whole} ${kind === 'FNA' ? ticker : name} on coin ${short(outpoint)}. `, el('span', { class: 'mono' }, r.contractId)))
}))

$('#i-kind').addEventListener('change', () => {
  const ufa = $('#i-kind').value === 'UFA'
  $('#i-ticker-wrap').hidden = ufa
  $('#i-details-wrap').hidden = !ufa
  if (ufa && $('#i-name').value === 'Bunting Flags') $('#i-name').value = 'Club Shares'
})

// ---- receive -------------------------------------------------------------

$('#invoice').addEventListener('click', guard('#invoice-out', () => {
  let id = $('#r-asset').value
  if (!id) {
    id = $('#r-contract')?.value?.trim()
    if (!id) {
      $('#invoice-out').replaceChildren(el('div', { class: 'row' }, el('label', {}, 'Contract ID', el('input', { id: 'r-contract', class: 'mono', placeholder: 'contract:…' }))), note('warn', 'Paste the contract ID, then make the invoice again. The amount is in the asset\'s smallest unit.'))
      return
    }
    rgbjs.parseContractId(id)
  }
  const h = holdings.get(id)
  const typed = $('#r-amount').value.trim()
  if (!/^\d+(\.\d+)?$/.test(typed) || Number(typed) <= 0) throw new Error('The amount is a positive number.')
  const decimals = h?.summary?.decimals ?? 0
  const [whole, frac = ''] = typed.split('.')
  if (frac.length > decimals) throw new Error(`This asset has ${decimals} decimal places.`)
  const value = BigInt(whole + frac.padEnd(decimals, '0')).toString()
  // The payment lands on one of your coins: one with no other asset on it.
  // Prefer an empty coin: paying from a coin can't also pay into it.
  const coin = coins.find(c => !assetsOn(c.outpoint).length) ?? coins.find(c => assetsOn(c.outpoint).every(x => x === id))
  if (!coin) throw new Error('Every coin here already carries another asset, and Bunting keeps one asset per coin. Send yourself another coin first.')
  const nonce = state.nonce++
  const inv = v012.createInvoice({ contractId: id, value, outpoint: coin.outpoint, noiseSeed: w.noiseSeed, nonce })
  state.seals.push({ contractId: id, outpoint: coin.outpoint, nonce, invoice: inv.invoice, value, at: new Date().toISOString() })
  if (!state.contracts[id]) state.contracts[id] = { files: [] }
  persist()
  const button = el('span', {}, el('button', { class: 'quiet', onclick: e => copy(inv.invoice, e.target) }, 'Copy invoice'), ' ',
    el('button', { class: 'quiet', onclick: e => copy(linkTo('pay', encodeURIComponent(inv.invoice)), e.target) }, 'Copy a pay link'))
  $('#invoice-out').replaceChildren(note('ok', el('div', { class: 'mono' }, inv.invoice), el('div', { class: 'row' }, button),
    el('p', { class: 'small' }, `Paid to coin ${short(coin.outpoint)}. When the payer sends you the transfer file, take it in below.`)))
}))

$('#accept-file').addEventListener('change', guard('#accept-out', async e => {
  const file = e.target.files[0]
  if (!file) return
  const bytes = new Uint8Array(await file.arrayBuffer())
  e.target.value = ''
  takeIn(bytes)
}))

function takeIn (bytes) {
  const r = rgbjs.validateConsignment(bytes)
  if (!r.valid) throw new Error(`This file isn't valid: ${r.error}`)
  if (r.line !== 'v0.12') throw new Error('Bunting holds RGB v0.12 assets only.')
  const got = []
  for (const s of state.seals.filter(s => s.contractId === r.contractId)) {
    const rec = v012.receive(bytes, { outpoint: s.outpoint, noiseSeed: w.noiseSeed, nonce: s.nonce }).receive
    got.push(...rec.received)
  }
  const isOurs = Object.prototype.hasOwnProperty.call(state.contracts, r.contractId) && state.contracts[r.contractId].files.length
  if (!got.length && !isOurs) throw new Error('This transfer isn\'t for any invoice made in this wallet.')
  const b64 = toBase64(bytes)
  state.contracts[r.contractId] ??= { files: [] }
  if (!state.contracts[r.contractId].files.includes(b64)) state.contracts[r.contractId].files.push(b64)
  persist()
  computeHoldings(); render(); checkWitnesses()
  const s = rgbjs.assetSummary(r)
  const h = holdings.get(r.contractId)
  $('#accept-out').replaceChildren(got.length
    ? note(r.issuer?.trusted ? 'ok' : 'warn',
      `Received ${got.map(g => amount(h, g.value)).join(' and ')} of ${s.name ?? 'an asset'} by witness transaction ${short(got[0].witness ?? '')}. `,
      r.issuer?.trusted ? 'Its issuer is a standard one rgbjs trusts. ' : 'Careful: its issuer isn\'t one rgbjs trusts, so what its state means is the sender\'s word. ',
      'It is yours once that transaction is mined: see Assets.')
    : note('warn', 'Taken in, but nothing in it is paid to your invoices.'))
}

// ---- pay -----------------------------------------------------------------

let pending = null

$('#build').addEventListener('click', guard('#pay-out', async () => {
  pending = null
  const invoice = $('#p-invoice').value.trim()
  const inv = rgbjs.parseInvoice(invoice)
  if (inv.line !== 'v0.12') throw new Error('Bunting pays RGB v0.12 invoices only.')
  const id = inv.contractId
  const h = holdings.get(id)
  if (!h || !h.cells.length) throw new Error('You hold none of this asset here.')
  const rate = Number($('#p-rate').value)
  if (!(rate >= 1 && rate <= 1000)) throw new Error('The fee rate is a number of sat/vB, at least 1.')
  $('#pay-out').replaceChildren(note('', 'Building the payment…'))
  // Only coins that carry this asset can be spent; rgbjs picks among them.
  const spendable = coins.filter(c => assetsOn(c.outpoint).includes(id))
  const withTx = await Promise.all(spendable.map(async c => ({ outpoint: c.outpoint, sats: c.sats, terminal: c.terminal, tx: await chain.txHex(c.outpoint.split(':')[0]) })))
  // tapret: the commitment rides in the change output's taproot key, so the
  // transaction has no OP_RETURN for a node's data-carrier policy to refuse.
  const build = fee => v012.payInvoice({
    contracts: files(id), invoice, descriptor: w.descriptor, coins: withTx, fee, commit: 'tapret',
    seals: state.seals.filter(s => s.contractId === id).map(s => ({ outpoint: s.outpoint, nonce: s.nonce })),
    noiseSeed: w.noiseSeed
  })
  // Build once to learn the transaction's shape, then again with the exact
  // fee for its size: the inputs and outputs stay the same, only the change shrinks.
  const sized = tx => { const x = parseTx(tx); return vsizeOf(x.ins.length, x.outs.map(o => bytesToHex(o.script))) }
  let p = build(Math.ceil(rate * 200))
  const fee = Math.ceil(rate * sized(p.tx))
  p = build(fee)
  // One asset per coin: refuse a payment that would spend a coin carrying another.
  const spent = parseTx(p.tx).ins.map(outpointOf)
  const other = spent.flatMap(op => assetsOn(op).filter(x => x !== id))
  if (other.length) throw new Error(`This payment would spend a coin that also carries ${other.join(', ')}, which would be lost. Bunting won't sign it.`)
  const own = state.seals.find(s => s.invoice === invoice || (s.contractId === id && spent.includes(s.outpoint) && invoice.includes(v012.createInvoice({ contractId: id, value: s.value, outpoint: s.outpoint, noiseSeed: w.noiseSeed, nonce: s.nonce }).authToken)))
  if (own && spent.includes(own.outpoint)) throw new Error('This invoice pays to a coin this payment would spend, so the asset would be lost. Make the invoice on another coin.')
  pending = { p, id, invoice, spent }
  const out = parseTx(p.tx).outs
  $('#pay-out').replaceChildren(
    note('', el('div', {}, `Pays ${amount(h, inv.amount)} for a fee of ${fee} sats (${rate} sat/vB). `, `Spends ${spent.length} coin${spent.length === 1 ? '' : 's'} and makes ${out.length} output${out.length === 1 ? '' : 's'}; the change at output ${p.change?.vout} carries the RGB commitment and what's left of the asset.`),
      el('div', { class: 'mono small' }, `witness ${p.txid}`), el('div', { class: 'small' }, 'The commitment is inside the change output\'s taproot key (tapret), so there is no OP_RETURN output.')),
    note('warn', 'Signing broadcasts the transaction to the BLAKE2b chain, through ', chain.apiBase(), ' and Nostr relays. It can\'t be taken back, and its fee can\'t be raised later: a replacement would no longer match the transfer file the payee gets.',
      el('div', { class: 'row' }, el('button', { id: 'sign', onclick: guard('#pay-out', signAndSend) }, 'Sign and broadcast'), el('button', { class: 'quiet', onclick: () => { pending = null; $('#pay-out').replaceChildren() } }, 'Cancel')))
  )
}))

async function signAndSend () {
  if (!pending) return
  const { p, id, invoice, spent } = pending
  pending = null
  $('#sign')?.setAttribute('disabled', '')
  const keys = {}
  for (const op of spent) {
    const c = coins.find(x => x.outpoint === op)
    if (!c) throw new Error(`coin ${op} isn't in this wallet`)
    keys[op] = { sats: c.sats, script: c.script, key: w.signingKey(c.terminal, c.merkleRoot) }
  }
  const signed = signTx(p.tx, keys)
  // Two routes, as some nodes' policies refuse what others accept: the
  // explorer's node, and Nostr relays where a txbt4 node picks it up (Reef's way).
  const [direct, relayed] = await Promise.all([
    chain.broadcast(signed).then(id => ({ ok: id === p.txid, text: id }), e => ({ ok: false, text: e.message })),
    publish(parentTxEvent(signed))
  ])
  const relayedOk = Object.values(relayed).filter(r => r === 'ok').length
  if (!direct.ok && !relayedOk) throw new Error(`Nothing took the transaction. Explorer: ${direct.text}. Relays: ${JSON.stringify(relayed)}`)
  const txid = p.txid
  // Keep the payer's copy, which holds the change, alongside the earlier files,
  // and how to find and sign for the tapret change coin.
  state.contracts[id].files.push(toBase64(p.backup))
  if (p.tapret) (state.tapret ??= {})[p.tapret.scriptPubkey] = { terminal: p.change.terminal, merkleRoot: p.tapret.merkleRoot }
  state.sent.push({ txid, contractId: id, invoice, transfer: toBase64(p.transfer), at: new Date().toISOString() })
  persist()
  const ticker = (holdings.get(id)?.summary ? unit(holdings.get(id)) : 'rgb').replace(/[^A-Za-z0-9]+/g, '-')
  const name = `bunting-${ticker}-${txid.slice(0, 8)}.transfer.rgb`
  const sent = note('ok', 'Sent: ', link(`/tx/${txid}`, short(txid)), direct.ok ? ' (the explorer has it)' : ` (handed to ${relayedOk} Nostr relay${relayedOk === 1 ? '' : 's'}; the explorer's node refused it, so it shows there once mined)`, '. ')
  // An invoice this wallet made: the payment is already ours, nothing to hand over.
  if (state.seals.some(s => s.invoice === invoice)) sent.append('It pays one of this wallet\'s own invoices, so there is nothing to hand over.')
  else sent.append('Now give the payee the transfer file; they need it to see the payment.', handOver(p.transfer, name))
  $('#pay-out').replaceChildren(sent)
  setTimeout(refresh, 3000)
}

// ---- send tBTC -------------------------------------------------------------

let pendingSend = null

function planSend (outputs, rate) {
  if (!(rate >= 1 && rate <= 1000)) throw new Error('The fee rate is a number of sat/vB, at least 1.')
  for (const o of outputs) if (!Number.isSafeInteger(o.sats) || o.sats < DUST) throw new Error(`Each output is at least ${DUST} sats.`)
  const want = outputs.reduce((n, o) => n + o.sats, 0)
  const change = v012.deriveAddress(w.descriptor, PLAIN_CHANGE).scriptPubkey
  const inputs = []
  let have = 0
  for (const c of plainCoins()) {
    inputs.push(c)
    have += c.sats
    const fee = Math.ceil(rate * vsizeOf(inputs.length, [...outputs.map(o => o.script), change]))
    if (have >= want + fee) {
      const left = have - want - fee
      // Change below dust goes to the fee instead.
      const outs = left >= DUST ? [...outputs, { script: change, sats: left }] : outputs
      return { inputs, outputs: outs, fee: have - outs.reduce((n, o) => n + o.sats, 0), change: left >= DUST ? left : 0, rate }
    }
  }
  throw new Error(`Not enough in coins without assets: ${have.toLocaleString()} sats spendable here.`)
}

function showSend (plan, what) {
  pendingSend = plan
  $('#send-out').replaceChildren(
    note('', `${what} Spends ${plan.inputs.length} coin${plan.inputs.length === 1 ? '' : 's'} (${plan.inputs.map(c => short(c.outpoint)).join(', ')}); fee ${plan.fee} sats${plan.change ? `; ${plan.change.toLocaleString()} sats come back as change` : ''}.`),
    note('warn', 'Signing broadcasts it to the BLAKE2b chain. It can\'t be taken back.',
      el('div', { class: 'row' }, el('button', { id: 's-sign', onclick: guard('#send-out', signSend) }, 'Sign and broadcast'), el('button', { class: 'quiet', onclick: () => { pendingSend = null; $('#send-out').replaceChildren() } }, 'Cancel'))))
}

$('#s-build').addEventListener('click', guard('#send-out', () => {
  const script = addressScript($('#s-to').value)
  const sats = Number($('#s-amount').value)
  if (TERMINALS.some(t => v012.deriveAddress(w.descriptor, t).scriptPubkey === script)) throw new Error('That is this wallet\'s own address: use Split to make spare coins.')
  showSend(planSend([{ script, sats }], Number($('#s-rate').value)), `Sends ${sats.toLocaleString()} sats to ${$('#s-to').value.trim()}.`)
}))

$('#s-split').addEventListener('click', guard('#send-out', () => {
  const size = Number($('#s-split-size').value)
  const n = Number($('#s-split-n').value)
  if (!Number.isInteger(n) || n < 1 || n > SPARE.length) throw new Error(`Split into 1 to ${SPARE.length} coins at a time.`)
  const outputs = SPARE.slice(0, n).map(t => ({ script: v012.deriveAddress(w.descriptor, t).scriptPubkey, sats: size }))
  showSend(planSend(outputs, Number($('#s-rate').value)), `Makes ${n} spare coin${n === 1 ? '' : 's'} of ${size.toLocaleString()} sats here.`)
}))

async function signSend () {
  if (!pendingSend) return
  const plan = pendingSend
  pendingSend = null
  $('#s-sign')?.setAttribute('disabled', '')
  const hex = buildTx(plan.inputs, plan.outputs)
  const keys = Object.fromEntries(plan.inputs.map(c => [c.outpoint, { sats: c.sats, script: c.script, key: w.signingKey(c.terminal, c.merkleRoot) }]))
  const signed = signTx(hex, keys)
  const id = txidOf(parseTx(signed))
  const [direct, relayed] = await Promise.all([
    chain.broadcast(signed).then(t => ({ ok: t === id, text: t }), e => ({ ok: false, text: e.message })),
    publish(parentTxEvent(signed))
  ])
  const relayedOk = Object.values(relayed).filter(r => r === 'ok').length
  if (!direct.ok && !relayedOk) throw new Error(`Nothing took the transaction. Explorer: ${direct.text}`)
  $('#send-out').replaceChildren(note('ok', 'Sent: ', link(`/tx/${id}`, short(id)), direct.ok ? '.' : ` (handed to ${relayedOk} Nostr relay${relayedOk === 1 ? '' : 's'}; the explorer's node refused it).`))
  // Kept so its fee can be raised while it waits.
  ;(state.plainSent ??= []).push({ txid: id, inputs: plan.inputs, outputs: plan.outputs, fee: plan.fee, rate: plan.rate, at: new Date().toISOString() })
  persist()
  setTimeout(refresh, 3000)
}

async function renderPlainSent () {
  const waiting = []
  for (const s of (state.plainSent ?? []).slice(-5)) {
    const st = await chain.txStatus(s.txid).catch(() => null)
    if (st && !st.confirmed) waiting.push(s)
  }
  $('#plain-sent').replaceChildren(...(waiting.length ? [el('h3', { class: 'small' }, 'Waiting for a block')] : []),
    ...waiting.map(s => el('div', { class: 'row small' },
      el('span', { class: 'mono' }, link(`/tx/${s.txid}`, short(s.txid))), el('span', {}, `${s.rate} sat/vB, fee ${s.fee}`),
      el('button', { class: 'quiet', onclick: guard('#send-out', () => bump(s)) }, 'Raise the fee'))))
}

// BIP125: the same coins, the same payments, less change, a higher rate.
function bump (old) {
  const rate = Math.max(old.rate * 1.5, old.rate + 1)
  const vsize = vsizeOf(old.inputs.length, old.outputs.map(o => o.script))
  const fee = Math.ceil(rate * vsize)
  const change = v012.deriveAddress(w.descriptor, PLAIN_CHANGE).scriptPubkey
  const outputs = old.outputs.map(o => ({ ...o }))
  const c = outputs.find(o => o.script === change)
  if (!c) throw new Error('This send has no change to take a higher fee from.')
  c.sats -= fee - old.fee
  if (c.sats < DUST) throw new Error('Not enough change left to raise the fee.')
  showSend({ inputs: old.inputs, outputs, fee, rate, change: c.sats, replaces: old.txid }, `Replaces ${short(old.txid)} at ${rate} sat/vB.`)
}

// ---- this wallet ---------------------------------------------------------

/** Everything the seed can't rebuild. No keys: the seed is backed up apart. */
export function assetBackup () {
  return { kind: 'bunting-assets', version: 1, descriptor: w.descriptor, made: new Date().toISOString(),
    contracts: state.contracts, seals: state.seals, nonce: state.nonce, tapret: state.tapret ?? {}, sent: state.sent }
}

/** Merges a backup into this wallet; returns what it added. Refuses another wallet's backup. */
export function restoreAssets (b) {
  if (b?.kind !== 'bunting-assets' || b.version !== 1) throw new Error('This isn\'t a Bunting asset backup.')
  if (b.descriptor !== w.descriptor) throw new Error('This backup is from another wallet (its keys differ). Restore that wallet\'s seed first.')
  const added = { files: 0, invalid: 0, seals: 0, tapret: 0, sent: 0 }
  for (const [id, c] of Object.entries(b.contracts ?? {})) {
    for (const f of c.files ?? []) {
      const r = rgbjs.validateConsignment(fromBase64(f))
      if (!r.valid || r.contractId !== id) { added.invalid++; continue }
      state.contracts[id] ??= { files: [] }
      if (!state.contracts[id].files.includes(f)) { state.contracts[id].files.push(f); added.files++ }
    }
    state.contracts[id] ??= { files: [] }
  }
  for (const s of b.seals ?? []) {
    if (!state.seals.some(x => x.outpoint === s.outpoint && x.nonce === s.nonce)) { state.seals.push(s); added.seals++ }
  }
  // Never hand out a nonce twice: keep the highest counter either side has seen.
  state.nonce = Math.max(state.nonce, b.nonce ?? 0, ...state.seals.map(s => s.nonce + 1))
  for (const [script, rec] of Object.entries(b.tapret ?? {})) {
    if (!(state.tapret ??= {})[script]) { state.tapret[script] = rec; added.tapret++ }
  }
  for (const s of b.sent ?? []) if (!state.sent.some(x => x.txid === s.txid)) { state.sent.push(s); added.sent++ }
  persist()
  return added
}

$('#backup').addEventListener('click', guard('#backup-out', () => {
  const text = JSON.stringify(assetBackup(), null, 1)
  download(new TextEncoder().encode(text), `bunting-assets${WALLET ? `-${WALLET}` : ''}-${new Date().toISOString().slice(0, 10)}.json`)
  $('#backup-out').replaceChildren(note('ok', `Saved ${Object.keys(state.contracts).length} asset${Object.keys(state.contracts).length === 1 ? '' : 's'}, ${state.seals.length} invoice${state.seals.length === 1 ? '' : 's'} and ${Object.keys(state.tapret ?? {}).length} tapret coin record${Object.keys(state.tapret ?? {}).length === 1 ? '' : 's'}. It holds no keys, but it shows your history: keep it private.`))
}))

$('#restore-file').addEventListener('change', guard('#backup-out', async e => {
  const file = e.target.files[0]
  if (!file) return
  e.target.value = ''
  let b
  try { b = JSON.parse(await file.text()) } catch { throw new Error('That file isn\'t JSON.') }
  const a = restoreAssets(b)
  computeHoldings(); render(); refresh()
  $('#backup-out').replaceChildren(note(a.invalid ? 'warn' : 'ok',
    `Restored ${a.files} contract file${a.files === 1 ? '' : 's'}, ${a.seals} invoice${a.seals === 1 ? '' : 's'}, ${a.tapret} tapret coin record${a.tapret === 1 ? '' : 's'} and ${a.sent} payment${a.sent === 1 ? '' : 's'}.`,
    a.invalid ? ` ${a.invalid} file${a.invalid === 1 ? '' : 's'} didn't validate and ${a.invalid === 1 ? 'was' : 'were'} skipped.` : ''))
}))

$('#show-seed').addEventListener('click', () => { $('#seed').hidden = !$('#seed').hidden; $('#seed').textContent = state.seed })
$('#wipe').addEventListener('click', () => { $('#wipe-confirm').hidden = false })
$('#wipe-no').addEventListener('click', () => { $('#wipe-confirm').hidden = true })
$('#wipe-yes').addEventListener('click', () => { wipe(); location.reload() })

start()
