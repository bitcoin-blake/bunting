// Bunting: the wallet page. RGB comes from rgbjs; keys, signing and the
// chain are in ./lib. Every asset file and invoice secret stays in this tab.
import * as rgbjs from 'https://rgbjs.com/src/index.js'
import { fromBase64, hexToBytes, bytesToHex, toBase64 } from './lib/bytes.js'
import { sha256 } from './lib/deps.js'
import * as chain from './lib/esplora.js'
import { wallet } from './lib/keys.js'
import { parentTxEvent, publish } from './lib/nostr.js'
import { load, save, wipe } from './lib/store.js'
import { outpointOf, parseTx, signTx } from './lib/tx.js'

const { v012 } = rgbjs
const $ = s => document.querySelector(s)
// Receive keychain &0 and change keychain &1; rgbjs puts payment change on &1/0.
const TERMINALS = ['&0/0', '&0/1', '&0/2', '&0/3', '&0/4', '&1/0', '&1/1', '&1/2']
const FNA = { codexId: '7C15w3W1-L0T~zXw-Aeh5~kV-Zquz729-HXQFKQW-_5lX9O8', version: 0, checksum: 'AYkSrg' }
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

async function copy (text, button) {
  try { await navigator.clipboard.writeText(text); button.textContent = 'Copied' } catch { button.textContent = 'Select and copy it' }
}

// ---- setup -------------------------------------------------------------

function start () {
  if (!state.seed) { $('#setup').hidden = false; return }
  w = wallet(hexToBytes(state.seed))
  $('#setup').hidden = true
  $('#main').hidden = false
  $('#address').textContent = v012.deriveAddress(w.descriptor, '&0/0').address
  $('#api').textContent = chain.apiBase()
  refresh()
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

const assetsOn = outpoint => [...holdings].filter(([, h]) => h.cells.some(c => c.outpoint === outpoint)).map(([id]) => id)
const total = h => h.cells.reduce((n, c) => /^\d+$/.test(c.value) ? n + BigInt(c.value) : n, 0n)
const amount = (h, raw) => h?.summary ? `${rgbjs.formatAmount(String(raw), h.summary.decimals)} ${h.summary.ticker ?? ''}`.trim() : String(raw)

async function refresh () {
  $('#refresh').disabled = true
  try {
    const [height, found] = await Promise.all([chain.tip(), scanCoins()])
    coins = found
    $('#chain').textContent = `txbt4 at block ${height.toLocaleString()} · ${chain.apiBase().replace(/^https:\/\//, '')}`
    computeHoldings()
    render()
    checkWitnesses()
  } catch (e) {
    $('#chain').textContent = `Couldn't reach the chain: ${e.message}`
  } finally { $('#refresh').disabled = false }
}
$('#refresh').addEventListener('click', refresh)
$('#copy-address').addEventListener('click', e => copy($('#address').textContent, e.target))

function render () {
  const sats = coins.reduce((n, c) => n + c.sats, 0)
  fill($('#coins'), 
    el('tr', {}, el('th', {}, 'Coin'), el('th', {}, 'tBTC'), el('th', {}, 'Status'), el('th', {}, 'Carries')),
    ...coins.map(c => el('tr', {},
      el('td', { class: 'mono' }, link(`/tx/${c.outpoint.split(':')[0]}`, short(c.outpoint))),
      el('td', {}, (c.sats / 1e8).toFixed(8)),
      el('td', {}, c.confirmed ? `block ${c.confirmed}` : 'unconfirmed'),
      el('td', {}, assetsOn(c.outpoint).map(id => { const h = holdings.get(id); return amount(h, h.cells.filter(x => x.outpoint === c.outpoint).reduce((n, x) => n + BigInt(x.value), 0n)) }).join(', ') || '—'))),
    coins.length ? null : el('tr', {}, el('td', { colspan: 4, class: 'small' }, 'No coins yet. Send some txbt4 to the address above, mine some in Winch, or ask someone with a txbt4 node.')),
    coins.length ? el('tr', {}, el('td', { class: 'small' }, `${coins.length} coin${coins.length === 1 ? '' : 's'}`), el('td', {}, (sats / 1e8).toFixed(8)), el('td'), el('td')) : null
  )
  const ids = Object.keys(state.contracts)
  fill($('#assets'), 
    el('tr', {}, el('th', {}, 'Asset'), el('th', {}, 'You hold'), el('th', {}, 'On chain')),
    ...ids.map(id => {
      const h = holdings.get(id)
      return el('tr', {},
        el('td', {}, el('div', {}, h?.summary ? `${h.summary.name ?? ''} (${h.summary.ticker ?? '?'})` : 'Unknown asset'), el('div', { class: 'mono small' }, id)),
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
    el('button', { class: 'quiet', onclick: () => download(fromBase64(s.transfer), `bunting-${s.txid.slice(0, 8)}.transfer.rgb`) }, 'Transfer file')))] : []))
  $('#r-asset').replaceChildren(
    ...ids.map(id => el('option', { value: id }, holdings.get(id)?.summary?.ticker ?? short(id))),
    el('option', { value: '' }, 'Another asset: paste its contract ID')
  )
}

async function checkWitnesses () {
  for (const [id, h] of holdings) {
    const cell = document.getElementById(`w-${id.replace(/[^A-Za-z0-9]/g, '')}`)
    if (!cell || !h.witnesses.length) continue
    try {
      const c = await rgbjs.checkWitnesses(h.witnesses, { server: chain.apiBase() })
      const waiting = c.results.filter(x => x.state !== 'mined')
      const min = Math.min(...c.results.map(x => x.confirmations))
      cell.textContent = waiting.length
        ? `${waiting.length} of ${c.results.length} witness transaction${c.results.length === 1 ? '' : 's'} not mined yet`
        : `every witness mined, ${min}+ confirmation${min === 1 ? '' : 's'}`
    } catch (e) { cell.textContent = `couldn't check: ${e.message}` }
  }
}

// ---- issue ---------------------------------------------------------------

$('#issue').addEventListener('click', guard('#issue-out', () => {
  const ticker = $('#i-ticker').value.trim().toUpperCase()
  const name = $('#i-name').value.trim()
  const decimals = Number($('#i-precision').value)
  const whole = $('#i-supply').value.trim()
  const outpoint = $('#i-coin').value
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(ticker)) throw new Error('The ticker is 1 to 8 letters or digits, starting with a letter.')
  if (!name) throw new Error('Give the token a name.')
  if (!/^[1-9]\d*$/.test(whole)) throw new Error('The supply is a whole number of tokens.')
  const supply = Number(whole) * 10 ** decimals
  if (!Number.isSafeInteger(supply)) throw new Error('That supply is too large here.')
  const params = {
    consensus: 'bitcoin', testnet: true, method: 'issue', timestamp: new Date().toISOString(), issuer: FNA,
    name: (name.replace(/[^A-Za-z0-9_]/g, '') || 'Token').replace(/^(\d)/, 'T$1'),
    global: [{ name: 'ticker', verified: ticker }, { name: 'name', verified: name }, { name: 'precision', verified: PRECISION[decimals] }, { name: 'issued', verified: supply }],
    owned: [{ name: 'balance', seal: outpoint, data: supply }]
  }
  const bytes = v012.issueContract(params, w.noiseSeed)
  const r = rgbjs.validateConsignment(bytes)
  if (!r.valid) throw new Error(`rgbjs made a contract it doesn't accept: ${r.error}`)
  state.contracts[r.contractId] = { files: [toBase64(bytes)] }
  persist()
  computeHoldings(); render()
  $('#issue-out').replaceChildren(note('ok', `Issued ${whole} ${ticker} on coin ${short(outpoint)}. `, el('span', { class: 'mono' }, r.contractId)))
}))

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
  const button = el('button', { class: 'quiet', onclick: e => copy(inv.invoice, e.target) }, 'Copy invoice')
  $('#invoice-out').replaceChildren(note('ok', el('div', { class: 'mono' }, inv.invoice), el('div', { class: 'row' }, button),
    el('p', { class: 'small' }, `Paid to coin ${short(coin.outpoint)}. When the payer sends you the transfer file, take it in below.`)))
}))

$('#accept-file').addEventListener('change', guard('#accept-out', async e => {
  const file = e.target.files[0]
  if (!file) return
  const bytes = new Uint8Array(await file.arrayBuffer())
  e.target.value = ''
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
}))

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
  const fee = Number($('#p-fee').value)
  if (!Number.isSafeInteger(fee) || fee < 150) throw new Error('The fee is a whole number of sats, at least 150.')
  $('#pay-out').replaceChildren(note('', 'Building the payment…'))
  // Only coins that carry this asset can be spent; rgbjs picks among them.
  const spendable = coins.filter(c => assetsOn(c.outpoint).includes(id))
  const withTx = await Promise.all(spendable.map(async c => ({ outpoint: c.outpoint, sats: c.sats, terminal: c.terminal, tx: await chain.txHex(c.outpoint.split(':')[0]) })))
  // tapret: the commitment rides in the change output's taproot key, so the
  // transaction has no OP_RETURN for a node's data-carrier policy to refuse.
  const p = v012.payInvoice({
    contracts: files(id), invoice, descriptor: w.descriptor, coins: withTx, fee, commit: 'tapret',
    seals: state.seals.filter(s => s.contractId === id).map(s => ({ outpoint: s.outpoint, nonce: s.nonce })),
    noiseSeed: w.noiseSeed
  })
  // One asset per coin: refuse a payment that would spend a coin carrying another.
  const spent = parseTx(p.tx).ins.map(outpointOf)
  const other = spent.flatMap(op => assetsOn(op).filter(x => x !== id))
  if (other.length) throw new Error(`This payment would spend a coin that also carries ${other.join(', ')}, which would be lost. Bunting won't sign it.`)
  const own = state.seals.find(s => s.invoice === invoice || (s.contractId === id && spent.includes(s.outpoint) && invoice.includes(v012.createInvoice({ contractId: id, value: s.value, outpoint: s.outpoint, noiseSeed: w.noiseSeed, nonce: s.nonce }).authToken)))
  if (own && spent.includes(own.outpoint)) throw new Error('This invoice pays to a coin this payment would spend, so the asset would be lost. Make the invoice on another coin.')
  pending = { p, id, invoice, spent }
  const out = parseTx(p.tx).outs
  $('#pay-out').replaceChildren(
    note('', el('div', {}, `Pays ${amount(h, inv.amount)} for a fee of ${fee} sats. `, `Spends ${spent.length} coin${spent.length === 1 ? '' : 's'}; ${out.length} outputs, the first commits to the RGB transfer.`),
      el('div', { class: 'mono small' }, `witness ${p.txid}`), el('div', { class: 'small' }, 'The commitment is inside the change output (tapret): no OP_RETURN.')),
    note('warn', 'Signing broadcasts the transaction to the BLAKE2b chain, through ', chain.apiBase(), ' and Nostr relays. It can\'t be taken back.',
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
  const ticker = holdings.get(id)?.summary?.ticker ?? 'rgb'
  const name = `bunting-${ticker}-${txid.slice(0, 8)}.transfer.rgb`
  $('#pay-out').replaceChildren(note('ok', 'Sent: ', link(`/tx/${txid}`, short(txid)), direct.ok ? ' (the explorer has it)' : ` (handed to ${relayedOk} Nostr relay${relayedOk === 1 ? '' : 's'}; the explorer's node refused it, so it shows there once mined)`, '. Now give the payee the transfer file; they need it to see the payment.',
    el('div', { class: 'row' }, el('button', { onclick: () => download(p.transfer, name) }, 'Download the transfer file'))))
  download(p.transfer, name)
  setTimeout(refresh, 3000)
}

// ---- this wallet ---------------------------------------------------------

$('#show-seed').addEventListener('click', () => { $('#seed').hidden = !$('#seed').hidden; $('#seed').textContent = state.seed })
$('#wipe').addEventListener('click', () => { $('#wipe-confirm').hidden = false })
$('#wipe-no').addEventListener('click', () => { $('#wipe-confirm').hidden = true })
$('#wipe-yes').addEventListener('click', () => { wipe(); location.reload() })

start()
