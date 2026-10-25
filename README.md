# Bunting

RGB assets on the Bitcoin BLAKE2b chain (txbt4), in a browser tab: issue a token, make an invoice, pay one, and take a payment in.

- **[bitcoin-blake.github.io/bunting](https://bitcoin-blake.github.io/bunting/)**: the wallet.
- **[test.html](https://bitcoin-blake.github.io/bunting/test.html)**: its tests, run in your browser.

Test coins only. One random seed kept in this tab gives a BIP86 taproot account, the keys that sign, and the RGB secrets. Nothing leaves the tab except the requests to the chain's explorer (coins, transactions, broadcast) at [mempool.guide](https://mempool.guide/testnet4/). Override it with `?api=<esplora url>`.

RGB is [rgbjs](https://rgbjs.com) (RGB v0.12, the RGB-WG crates compiled to wasm): it validates every file, builds each payment as an unsigned PSBT, and never holds a key. Bunting signs the transaction itself (BIP341 key path, checked against the BIP's own test vectors in `test.html`) and broadcasts it. The BLAKE2b fork changes block headers and proof of work, not transactions, so RGB works on it unchanged.

## Layout

- `index.html`, `app.js`: the wallet.
- `lib/keys.js`: the seed, the BIP86 account and its keys.
- `lib/tx.js`: parsing, serializing and signing transactions.
- `lib/esplora.js`: the chain, from an Esplora API.
- `lib/store.js`: what the tab keeps (in `localStorage`).
- `lib/deps.js`: the only third-party code, pinned: `@scure/bip32` and `@noble/curves` 2.4.0.

Plain ES modules, no build step, served from `gh-pages`.

## License

MIT
