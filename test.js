// Runs in the browser: the code under test imports its libraries by URL.
import { bytesToHex, hexToBytes } from './lib/bytes.js'
import { schnorr } from './lib/deps.js'
import { tweak, wallet } from './lib/keys.js'
import { parentTxEvent } from './lib/nostr.js'
import { outpointOf, parseTx, serializeTx, signTx, taprootSighash, txid } from './lib/tx.js'

const out = document.getElementById('out')
const results = []
async function test (name, fn) {
  const li = document.createElement('li')
  try { await fn(); li.className = 'pass'; li.textContent = name; results.push(true) } catch (e) {
    li.className = 'fail'; li.textContent = `${name}: ${e.message}`; results.push(false); console.error(e)
  }
  out.append(li)
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${a} !== ${b}`) }

const vectors = await (await fetch('https://raw.githubusercontent.com/bitcoin/bips/master/bip-0341/wallet-test-vectors.json')).json()
const kp = vectors.keyPathSpending[0]

await test('BIP341 vectors: transactions parse and re-serialize byte for byte', () => {
  eq(bytesToHex(serializeTx(parseTx(kp.given.rawUnsignedTx))), kp.given.rawUnsignedTx, 'unsigned tx')
})

await test('BIP341 vectors: key tweaks match', () => {
  for (const s of kp.inputSpending) {
    const root = s.given.merkleRoot ? hexToBytes(s.given.merkleRoot) : new Uint8Array(0)
    eq(bytesToHex(tweak(hexToBytes(s.given.internalPrivkey), root)), s.intermediary.tweakedPrivkey, `input ${s.given.txinIndex}`)
  }
})

await test('BIP341 vectors: SIGHASH_DEFAULT messages and signatures match', () => {
  const tx = parseTx(kp.given.rawUnsignedTx)
  const prevouts = kp.given.utxosSpent.map(u => ({ sats: u.amountSats, script: hexToBytes(u.scriptPubKey) }))
  const defaults = kp.inputSpending.filter(s => s.given.hashType === 0)
  if (!defaults.length) throw new Error('no SIGHASH_DEFAULT input in the vectors')
  for (const s of defaults) {
    const msg = taprootSighash(tx, s.given.txinIndex, prevouts)
    eq(bytesToHex(msg), s.intermediary.sigHash, `sighash of input ${s.given.txinIndex}`)
    // The vectors sign with all-zero auxiliary randomness.
    eq(bytesToHex(schnorr.sign(msg, hexToBytes(s.intermediary.tweakedPrivkey), new Uint8Array(32))), s.expected.witness[0], 'signature')
  }
})

// A whole payment through rgbjs on made-up coins: nothing is broadcast.
const rgbjs = await import('https://rgbjs.com/src/index.js')
const seed = new Uint8Array(32).fill(5)
const w = wallet(seed)

await test('the wallet descriptor gives taproot addresses whose keys it can sign for', () => {
  for (const t of ['&0/0', '&0/7', '&1/0']) {
    const { scriptPubkey } = rgbjs.v012.deriveAddress(w.descriptor, t)
    eq(scriptPubkey.slice(4), bytesToHex(schnorr.getPublicKey(w.signingKey(t))), t)
  }
})

await test('issue, invoice, pay, sign: the signed transaction is the witness the transfer commits to', () => {
  const { scriptPubkey } = rgbjs.v012.deriveAddress(w.descriptor, '&0/0')
  const fund = parseTx('02000000' + '01' + '33'.repeat(32) + '00000000' + '00' + 'fdffffff' + '01' + bytesToHex(new Uint8Array(new BigUint64Array([30000n]).buffer)) + '22' + scriptPubkey + '00000000')
  const coin = { outpoint: `${txid(fund)}:0`, sats: 30000, terminal: '&0/0', tx: bytesToHex(serializeTx(fund)) }
  const contract = rgbjs.v012.issueContract({ consensus: 'bitcoin', testnet: true, method: 'issue', timestamp: '2026-10-25T12:00:00+00:00', name: 'Flags',
    issuer: { codexId: '7C15w3W1-L0T~zXw-Aeh5~kV-Zquz729-HXQFKQW-_5lX9O8', version: 0, checksum: 'AYkSrg' },
    global: [{ name: 'ticker', verified: 'FLAG' }, { name: 'name', verified: 'Flags' }, { name: 'precision', verified: 'indivisible' }, { name: 'issued', verified: 100 }],
    owned: [{ name: 'balance', seal: coin.outpoint, data: 100 }] }, w.noiseSeed)
  const contractId = rgbjs.validateConsignment(contract).contractId
  const payee = new Uint8Array(32).fill(6)
  const inv = rgbjs.v012.createInvoice({ contractId, value: 25, outpoint: `${'44'.repeat(32)}:0`, noiseSeed: payee, nonce: 0 })
  const p = rgbjs.v012.payInvoice({ contracts: contract, invoice: inv.invoice, descriptor: w.descriptor, coins: [coin], fee: 300, noiseSeed: w.noiseSeed, commit: 'tapret' })
  const signed = signTx(p.tx, { [coin.outpoint]: { sats: coin.sats, script: scriptPubkey, key: w.signingKey(coin.terminal) } })
  // The tapret change can be signed for: its tweaked key is the one it pays to.
  eq(bytesToHex(schnorr.getPublicKey(w.signingKey(p.change.terminal, p.tapret.merkleRoot))), p.tapret.scriptPubkey.slice(4), 'tapret change key')
  const tx = parseTx(signed)
  eq(txid(tx), p.txid, 'signing leaves the txid alone')
  eq(tx.ins[0].witness[0].length, 64, 'a 64-byte key-path signature')
  eq(outpointOf(tx.ins[0]), coin.outpoint, 'spends the issued coin')
  eq(rgbjs.v012.receive(p.transfer, { outpoint: `${'44'.repeat(32)}:0`, noiseSeed: payee, nonce: 0 }).receive.received[0].value, '25', 'payee receives')
})

await test('signTx refuses a key that does not match the coin', () => {
  const { scriptPubkey } = rgbjs.v012.deriveAddress(w.descriptor, '&0/0')
  const hex = '02000000' + '01' + '55'.repeat(32) + '00000000' + '00' + 'fdffffff' + '01' + '1027000000000000' + '22' + scriptPubkey + '00000000'
  const op = outpointOf(parseTx(hex).ins[0])
  try { signTx(hex, { [op]: { sats: 1000, script: scriptPubkey, key: w.signingKey('&0/1') } }) } catch (e) { if (/doesn't match/.test(e.message)) return; throw e }
  throw new Error('signed anyway')
})

await test('the Nostr payment event is kind 23503, tagged for tally, and its signature verifies', async () => {
  const ev = parentTxEvent('0200')
  eq(ev.kind, 23503, 'kind'); eq(ev.content, '0200', 'content'); eq(JSON.stringify(ev.tags), '[["chain","sidestr:tally"]]', 'tags')
  const { sha256 } = await import('./lib/deps.js')
  eq(bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])))), ev.id, 'id')
  if (!schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))) throw new Error('signature does not verify')
})

const failed = results.filter(r => !r).length
document.getElementById('summary').textContent = failed ? `${failed} of ${results.length} failed` : `All ${results.length} passed`
document.title = failed ? 'Bunting tests: FAIL' : 'Bunting tests: pass'
