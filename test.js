// Runs in the browser: the code under test imports its libraries by URL.
import { bytesToHex, hexToBytes } from './lib/bytes.js'
import { schnorr } from './lib/deps.js'
import { tweak, wallet } from './lib/keys.js'
import { parentTxEvent } from './lib/nostr.js'
import * as vault from './lib/vault.js'
import { conversationKey, decrypt, encrypt, paddedLength } from './lib/nip44.js'
import { blockHash, expectedBits, merkleRoot, parseHeader, powOk, target } from './lib/spv.js'
import { addressScript } from './lib/address.js'
import { buildTx, vsizeOf } from './lib/tx.js'
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

await test('an RGB25 asset (no ticker) issues, pays with tapret and signs', () => {
  const { scriptPubkey } = rgbjs.v012.deriveAddress(w.descriptor, '&0/3')
  const fund = parseTx('02000000' + '01' + '66'.repeat(32) + '00000000' + '00' + 'fdffffff' + '01' + bytesToHex(new Uint8Array(new BigUint64Array([20000n]).buffer)) + '22' + scriptPubkey + '00000000')
  const coin = { outpoint: `${txid(fund)}:0`, sats: 20000, terminal: '&0/3', tx: bytesToHex(serializeTx(fund)) }
  const contract = rgbjs.v012.issueContract({ consensus: 'bitcoin', testnet: true, method: 'issue', timestamp: '2026-10-25T12:00:00+00:00', name: 'ClubShares',
    issuer: { codexId: 'mqmGvodN-WxpxyRb-RsGHiTQ-jDoRvMy-ClhrQGx-FMa5Cpw', version: 0, checksum: 'aiRB3w' },
    global: [{ name: 'details', verified: null, unverified: 'One vote each.' }, { name: 'name', verified: 'Club Shares' }, { name: 'precision', verified: 'indivisible' }, { name: 'issued', verified: 100 }],
    owned: [{ name: 'balance', seal: coin.outpoint, data: 100 }] }, w.noiseSeed)
  const r = rgbjs.validateConsignment(contract)
  eq(r.issuer.trusted, true, 'trusted RGB25 issuer'); eq(rgbjs.assetSummary(r).ticker, null, 'no ticker')
  const payee = new Uint8Array(32).fill(8)
  const inv = rgbjs.v012.createInvoice({ contractId: r.contractId, value: 30, outpoint: `${'77'.repeat(32)}:0`, noiseSeed: payee, nonce: 0 })
  const p = rgbjs.v012.payInvoice({ contracts: contract, invoice: inv.invoice, descriptor: w.descriptor, coins: [coin], fee: 300, noiseSeed: w.noiseSeed, commit: 'tapret' })
  const signed = signTx(p.tx, { [coin.outpoint]: { sats: coin.sats, script: scriptPubkey, key: w.signingKey(coin.terminal) } })
  eq(txid(parseTx(signed)), p.txid, 'signed witness')
  eq(rgbjs.v012.receive(p.transfer, { outpoint: `${'77'.repeat(32)}:0`, noiseSeed: payee, nonce: 0 }).receive.received[0].value, '30', 'payee receives')
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

await test('addresses decode to scripts: BIP173 and BIP350 test vectors, and Bunting\'s own', () => {
  eq(addressScript('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), '0014751e76e8199196d454941c45d1b3a323f1433bd6', 'p2wpkh')
  eq(addressScript('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7'), '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262', 'p2wsh')
  eq(addressScript('tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c'), '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433', 'p2tr')
  const own = rgbjs.v012.deriveAddress(w.descriptor, '&0/5')
  eq(addressScript(own.address), own.scriptPubkey, 'Bunting\'s address')
  for (const bad of ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsy', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'tb1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k']) {
    let threw = false
    try { addressScript(bad) } catch { threw = true }
    if (!threw) throw new Error(`accepted ${bad}`)
  }
})

await test('a plain send builds, signs and has the estimated size', () => {
  const { scriptPubkey } = rgbjs.v012.deriveAddress(w.descriptor, '&0/0')
  const coin = { outpoint: `${'88'.repeat(32)}:1`, sats: 10000 }
  const outs = [{ script: '0014751e76e8199196d454941c45d1b3a323f1433bd6', sats: 4000 }, { script: scriptPubkey, sats: 5700 }]
  const signed = signTx(buildTx([coin], outs), { [coin.outpoint]: { sats: coin.sats, script: scriptPubkey, key: w.signingKey('&0/0') } })
  const tx = parseTx(signed)
  eq(tx.ins[0].sequence, 0xfffffffd, 'replaceable')
  eq(outpointOf(tx.ins[0]), coin.outpoint, 'spends the coin')
  const weight = serializeTx(tx, { witness: false }).length * 3 + serializeTx(tx).length
  eq(Math.ceil(weight / 4), vsizeOf(1, outs.map(o => o.script)), 'vsize estimate')
})

// Block 153,567 of the BLAKE2b testnet4, which mined the Alice-to-Bob payment.
const H153567 = '000000a0d0efd9aee815106c06a6c1045beb40edb6ebd18e542ad90d1dbd6348000000004baad255e7636ffc8f0af35952d3e9a28be75467dd883b401350817a8df168481af9dd6affff001d3cfc370000000000da24010000000000000000024242424242424242000000000600000000000000000000000000000000000000df5702000000000000000000000000000000000000000000000000000000000000000000'
const H153566 = '000000a0755ba51c353541d873191be6811d1e1b9d5cd77bcf820183ec7b08fc000000006c4258f39b38a92eaa4810c8862f3ad4e9ab1f1c3c1643d5780a7144270d67552df4dd6affff001dc8201000000000006f23010000000000000000024242424242424242000000000100000000000000000000000000000000000000de5702000000000000000000000000000000000000000000000000000000000000000000'

await test('a BLAKE2b v2 header parses, hashes to its block hash and meets its target', () => {
  const h = parseHeader(H153567)
  eq(h.height, 153567, 'committed height')
  eq(blockHash(h), '00000000ec1dee306434956ddc0c4818db98b7e57cc43fe8c0d562329fc0b365', 'block hash')
  eq(h.merkleRoot, '4868f18d7a815013403b88dd6754e78ba2e9d35259f30a8ffc6f63e755d2aa4b', 'merkle root')
  eq(powOk(h), true, 'proof of work')
  eq(target(0x1d00ffff), 0x00000000ffff0000000000000000000000000000000000000000000000000000n, 'target from bits')
  eq(h.prevBlockHash, blockHash(parseHeader(H153566)), 'links to block 153,566')
  const tampered = parseHeader(H153567.slice(0, 160) + 'ff' + H153567.slice(162)) // a nonce byte
  eq(powOk(tampered), false, 'a changed nonce fails the target')
})

await test('a merkle proof leads from the txid to the header\'s merkle root', () => {
  const merkle = ['d728fae77cf9e3fe01aeceeef03ad230a134464943dc6d573e0308d0e2888db8', '3a48951bcc91e847a32ee7ef30682aba5e74b1a1fcc5621e0f62d7ebc8ed7515', '186b6b99baf65cdb379737f34c1bde2adb8558342a0a61945baf2e974be41297']
  const txid = '3e0bafc938cb94c0d9f33f6a85824ccbfe7bfb6a9283e7f721e29a4386b1ae6d'
  eq(merkleRoot(txid, merkle, 2), parseHeader(H153567).merkleRoot, 'root')
  if (merkleRoot(txid, merkle, 3) === parseHeader(H153567).merkleRoot) throw new Error('a wrong position still matched')
  if (merkleRoot('00'.repeat(32), merkle, 2) === parseHeader(H153567).merkleRoot) throw new Error('another txid still matched')
})

await test('difficulty: blake\'s real retarget at 153,216 and the 20-minute exception', () => {
  // Period 151,200–153,215: first block bits 0x19050947 at 1789654675, last block at 1792486248.
  eq(expectedBits(153216, { time: 1792502028 }, { time: 1792486248, bits: 0x1d00ffff }, { time: 1789654675, bits: 0x19050947 }), 0x190bca17, 'retarget')
  const prev = parseHeader(H153566)
  const cur = parseHeader(H153567)
  const period = { bits: 0x190bca17, time: 1792502028 }
  if (!(cur.time > prev.time + 1200)) throw new Error('expected a gap of more than 20 minutes')
  eq(expectedBits(153567, cur, prev, period), 0x1d00ffff, 'more than 20 minutes after the last block: minimum difficulty allowed')
  eq(cur.bits, 0x1d00ffff, 'and that is what block 153,567 carries')
  eq(expectedBits(153567, { time: prev.time + 600 }, prev, period), 0x190bca17, 'ten minutes after: the period\'s difficulty is required')
})

await test('NIP-44 v2: the spec\'s vectors for keys, padding, encryption and invalid payloads', async () => {
  const v = (await (await fetch('https://raw.githubusercontent.com/paulmillr/nip44/main/nip44.vectors.json')).json()).v2
  for (const c of v.valid.get_conversation_key) eq(bytesToHex(conversationKey(hexToBytes(c.sec1), c.pub2)), c.conversation_key, 'conversation key')
  for (const [len, padded] of v.valid.calc_padded_len) eq(paddedLength(len), padded, `padded length of ${len}`)
  for (const c of v.valid.encrypt_decrypt) {
    const key = hexToBytes(c.conversation_key)
    eq(encrypt(c.plaintext, key, hexToBytes(c.nonce)), c.payload, 'payload')
    eq(decrypt(c.payload, key), c.plaintext, 'plaintext')
  }
  for (const c of v.invalid.decrypt) {
    let threw = false
    try { decrypt(c.payload, hexToBytes(c.conversation_key)) } catch { threw = true }
    if (!threw) throw new Error(`accepted an invalid payload: ${c.note}`)
  }
})

await test('a wallet backup decrypts with its passphrase, and only with it', async () => {
  const contents = { seed: '11'.repeat(32), assets: { kind: 'bunting-assets', version: 1, nonce: 4 } }
  const file = await vault.seal(contents, 'correct horse battery')
  eq(file.kdf.iterations, 600000, 'iterations')
  if (JSON.stringify(file).includes('11111111')) throw new Error('the seed shows through')
  eq(JSON.stringify(await vault.open(JSON.parse(JSON.stringify(file)), 'correct horse battery')), JSON.stringify(contents), 'round trip')
  let threw = false
  try { await vault.open(file, 'correct horse batterY') } catch (e) { threw = /Wrong passphrase/.test(e.message) }
  if (!threw) throw new Error('opened with the wrong passphrase')
  threw = false
  try { await vault.open({ ...file, kdf: { ...file.kdf, iterations: 1000 } }, 'correct horse battery') } catch (e) { threw = /too weak/.test(e.message) }
  if (!threw) throw new Error('accepted a weak key derivation')
  threw = false
  try { await vault.seal(contents, 'short') } catch { threw = true }
  if (!threw) throw new Error('accepted a short passphrase')
})

await test('base64 handles megabytes (contract histories and backups grow)', async () => {
  const { toBase64, fromBase64 } = await import('./lib/bytes.js')
  const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i * 7)
  const back = fromBase64(toBase64(big))
  eq(back.length, big.length, 'length')
  eq(back.every((x, i) => x === big[i]), true, 'bytes')
})

const failed = results.filter(r => !r).length
document.getElementById('summary').textContent = failed ? `${failed} of ${results.length} failed` : `All ${results.length} passed`
document.title = failed ? 'Bunting tests: FAIL' : 'Bunting tests: pass'
