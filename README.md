# Bunting

RGB assets on the Bitcoin BLAKE2b testnet4 (txbt4), in a browser tab: issue a token, make an invoice, pay one, and take a payment in.

- **[bitcoin-blake.github.io/bunting](https://bitcoin-blake.github.io/bunting/)**: the wallet.
- **[test.html](https://bitcoin-blake.github.io/bunting/test.html)**: its tests, run in your browser.
- **[RGB on the BLAKE2b testnet4](https://rgb-docs.github.io/guides/development/rgb-on-blake/)**: why RGB works on txbt4, and the payments mined with Bunting.

**Test coins only.** One random seed kept in this tab (in `localStorage`) gives a BIP 86 taproot account (`m/86'/1'/0'`), the keys that sign, and the RGB secrets.

## What it does

- **Issue** an RGB20 token (ticker, fixed supply) or an RGB25 asset (no ticker, with terms) on one of your coins. Issuing costs nothing on chain.
- **Invoice.** The payment lands on a coin with no other asset on it. Invoices come with a pay link (`?pay=<invoice>`) and its QR code: scanned on a phone, it opens Bunting with the invoice ready. Open invoices can be cancelled; their secret is kept, so a late payment is still seen.
- **Pay.** [rgbjs](https://rgbjs.com) builds the payment as an unsigned PSBT with a **tapret** commitment (no `OP_RETURN`, which some nodes refuse). Bunting signs it itself (BIP 341 key path, checked against the BIP's own test vectors) and broadcasts it to the explorer and to Nostr relays (kind 23503, as Reef does). The fee is a sat/vB rate, prefilled from the explorer's estimate, and exact for the transaction's size. The payee gets the transfer **over Nostr** when the invoice came as a pay link: each wallet has a Nostr key from its seed, its pay links name it (`&to=<pubkey>`), and the payer's wallet encrypts the transfer to it (NIP-44 v2, tested on the spec's vectors) as a kind 1059 event signed by a throwaway key, which the payee's wallet takes in when it refreshes. Otherwise, or as well, it goes as a link (`#transfer=…`, after `#` so it never reaches a web server) or a file.
- **Take a transfer in** from Nostr, a link or a file: rgbjs validates it and finds what it pays to your invoices.
- **Send tBTC** and **split coins** into spare ones, never spending a coin that carries an asset or that an open invoice points at. A send waiting for a block can have its fee raised (BIP 125).
- **Back up and restore assets.** The seed brings back the keys; the asset backup (JSON, no keys) brings back the contract files, invoice secrets and tapret change records, which the seed can't.
- **Check confirmations in the tab**, not on the explorer's word (`lib/spv.js`): each witness's merkle proof against its block header; each v2 header's BLAKE2b proof of work (with the hasher from [bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema), pinned), committed height, time and difficulty (testnet4's rules as the fork keeps them); every link up to the tip; and the tip the chain's publisher signs on Nostr ([NIP-333](https://nip-333.github.io/)). A signed tip more than six hours old is shown with its age and not relied on.
- **Several wallets** in one browser with `?wallet=<name>`, and a short getting-started guide for a new one.

Each coin carries at most one asset, and Bunting won't sign a payment that would also spend a coin carrying another asset, which would lose it.

The explorer is [mempool.guide](https://mempool.guide/testnet4/) (an Esplora API); `?api=<esplora url>` uses another. Bunting talks to it for coins, transactions, broadcasts and headers, to Nostr relays for broadcasts and the signed tip, and to the CDNs below for code. Nothing else leaves the tab.

## Layout

- `index.html`, `app.js`: the wallet.
- `lib/keys.js`: the seed, the BIP 86 account, its keys and tweaks.
- `lib/tx.js`: parsing, building, serializing and signing transactions.
- `lib/address.js`: segwit addresses (BIP 173, BIP 350) to scripts.
- `lib/esplora.js`: the chain, from an Esplora API.
- `lib/spv.js`: confirmations checked in the tab.
- `lib/nostr.js`: broadcasting through Nostr relays.
- `lib/nip44.js`, `lib/deliver.js`: NIP-44 v2 encryption, and transfers sent to the payee over Nostr.
- `lib/store.js`: what the tab keeps.
- `lib/deps.js`: third-party code, pinned: `@scure/bip32`, `@noble/curves`, `@noble/hashes` and `@noble/ciphers` 2.4.0 (jsDelivr). Also `qrcode-generator` 1.4.4 (`index.html`), the schema repo's BLAKE2b hasher at a fixed commit (`lib/spv.js`), and rgbjs from [rgbjs.com](https://rgbjs.com).
- `scripts/og.py`: draws `og.png`.

Plain ES modules, no build step, served from `gh-pages`. The tests are in `test.html` and run in a browser.

## License

AGPL-3.0-or-later. See LICENSE.
