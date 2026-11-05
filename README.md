# polaris

Polaris sends an AI agent's cross-chain payment via NEAR Chain Signatures with an on-time guarantee. A NEAR contract pays out by default at the deadline unless Polaris submits delivery proof. Polaris bumps fees on its own stuck transactions to protect its pool.

## Day-1 spike

`spike/` is the day-1 risk check: derive a Base Sepolia address from a NEAR testnet account, broadcast an intentionally underpriced EIP-1559 payment, detect that it is stuck, then replace it at the same nonce with a higher fee that stays under a configurable cap.

### Tooling

Checked against current docs and the published packages, not the stale snippet on the chainsig.js npm readme.

| Piece | Value |
| --- | --- |
| MPC contract, testnet | `v1.signer-prod.testnet` |
| MPC contract, mainnet | `v1.signer` (not used here) |
| Library | `chainsig.js` 1.1.16 |
| NEAR client | `@near-js/accounts`, `@near-js/crypto`, `@near-js/providers`, `@near-js/signers` 2.5.x |
| EVM | `viem` |

[NEAR's signing guide](https://docs.near.org/chain-abstraction/chain-signatures/implementation) names `v1.signer-prod.testnet` for testnet. `chainsig.js` `CONTRACT_ADDRESSES.TESTNET` is that same id. A live `public_key` view on the contract returns the secp256k1 root key baked into chainsig.js:

`secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3`

Signing follows the library's current API (`examples/send-eth.ts` and the 1.1.16 types): `contract.sign({ payloads, path, keyType: "Ecdsa", signerAccount })`. The npm readme still shows `key_version` and a keypair passed to the constructor. That shape is not in 1.1.16. `near-api-js` is intentionally not a dependency; chainsig.js is built on `@near-js/*` v2, and mixing the two has broken transaction encoding before.

The script asks the contract to sign, waits for `FINAL`, and polls until `MPC_WAIT_MS` (default 180s). The `sign` method yields until the MPC network resumes it, so a signature often takes tens of seconds and sometimes longer.

### Setup

```bash
cd spike
npm install
cp .env.example .env
```

Fill in `.env`. Nothing in that file is committed. `spike/.gitignore` ignores `.env`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEAR_ACCOUNT_ID` | live spike | NEAR testnet account that pays for the MPC calls, for example `your-name.testnet` |
| `NEAR_PRIVATE_KEY` | live spike | That account's full-access key, `ed25519:...` |
| `BASE_SEPOLIA_RPC_URL` | no | Reads. Default `https://sepolia.base.org` |
| `BASE_SEPOLIA_SEQUENCER_URL` | no | `eth_sendRawTransaction`. Default `https://sepolia-sequencer.base.org` |
| `FEE_CAP_WEI` | no | Hard ceiling for the replacement. Default `1000000000` (1 gwei). The script refuses to sign above it |
| `REPLACEMENT_BUMP_BPS` | no | Bump over the stuck fees. Default `1000` (10%), which is Base's documented minimum for a replacement |
| `DERIVATION_PATH` | no | Default `polaris-base-sepolia`. One path per chain, so the signature is not reusable elsewhere |
| `MPC_CONTRACT_ID` | no | Default `v1.signer-prod.testnet` |
| `PAYMENT_TO` / `PAYMENT_WEI` | no | Default is 1 wei to the burn address |

Create the NEAR account with the faucet if you do not have one:

```bash
near create-account <name>.testnet --useFaucet
```

The account needs a fraction of a NEAR for gas. Two `sign` calls are the expensive part. The EVM key never exists locally; only the MPC network can sign for the derived address.

### Fund the derived address

`npm run dry-run` prints `derivedAddress` without signing or broadcasting. Send Base Sepolia ETH to that address from any of these faucets. Each one rate-limits claims, and the Coinbase, Alchemy, and QuickNode faucets require an account:

- [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet) (also `POST /v2/evm/faucet` with a CDP API key)
- [Alchemy Base Sepolia faucet](https://www.alchemy.com/faucets/base-sepolia)
- [QuickNode Base Sepolia faucet](https://faucet.quicknode.com/base/sepolia)
- [ethfaucet.com Base Sepolia](https://ethfaucet.com/networks/base/base-sepolia)

A few hundred thousand gwei is not enough once Base's L1 data fee is included. A typical faucet drip of 0.0001 ETH is enough for this 1 wei transfer. Wait until `eth_getBalance` is non-zero, then run the spike. The script stops before any MPC call when the address cannot cover `PAYMENT_WEI + 21000 * replacement maxFeePerGas`.

### Commands

```bash
cd spike
npm test                 # no network, no keys
npm run dry-run          # live Base fee + live MPC derived_public_key view, no broadcast
npm run probe:ingress    # unfunded throwaway key, shows how the sequencer answers an underpriced tx
npm run spike            # full path: sign, broadcast, wait, replace
```

### Expected output

With the Base Sepolia base fee at its 0.005 gwei floor (`5000000` wei) and a 0.001 gwei tip suggestion, the two payments share nonce `0`:

| Transaction | maxFeePerGas | maxPriorityFeePerGas |
| --- | --- | --- |
| Underpriced | `2500000` wei (0.0025 gwei), half the chain minimum, so it cannot be included while the floor holds | `1` wei |
| Replacement | `11000000` wei (0.011 gwei), which is `baseFee * 2 + tip` and more than 10% above the stuck fee | `1000000` wei (0.001 gwei) |

Both are EIP-1559 transactions on chain id `84532`. The replacement nonce equals the underpriced nonce. `FEE_CAP_WEI` stays at `1000000000`. If the base fee or the suggested tip moves, the script recomputes the replacement and still refuses to cross the cap.

`npm run dry-run` against `polaris-d1-z7npttup.testnet` on 5 Nov 2026 printed:

```text
derivedAddress: 0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6
derivationMatchesContract: true
baseSepoliaChainId: 84532
baseFee: 5000000 wei (0.005 gwei)
nonce: 0
nonceEqual: true
underpriced.maxFeePerGas: 2500000 wei (0.0025 gwei)
underpriced.maxPriorityFeePerGas: 1 wei (0.000000001 gwei)
replacement.maxFeePerGas: 11000000 wei (0.011 gwei)
replacement.maxPriorityFeePerGas: 1000000 wei (0.001 gwei)
balance: 0 wei
result: dry-run
```

A funded `npm run spike` adds both transaction hashes. The shape, once the derived address has ETH:

```text
underpriced.hash: 0x<accepted underpriced tx>
underpriced.observation: pending
underpriced.sawPending: true
replacement.hash: 0x<replacement tx>
replacement.signedNonce: <same as underpriced.signedNonce>
nonceEqual: true
replacement.status: success
underpriced.mined: no
result: replaced
```

`result: replaced` means the underpriced hash was observed pending, the replacement mined successfully, the nonces were equal, and the underpriced hash has no success receipt.

### What was verified, and what was not

Verified live on 5 Nov 2026, with no secrets committed:

- `v1.signer-prod.testnet` answers `public_key`, and that key matches chainsig.js.
- `derived_public_key` for `polaris-d1-z7npttup.testnet` and path `polaris-base-sepolia` matches chainsig.js local derivation. Address `0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6`, chain id `84532`, nonce `0`, base fee `5000000` wei.
- The NEAR account has testnet NEAR for gas (about 10 NEAR from the helper faucet). The derived Base address has 0 wei.
- `https://sepolia-sequencer.base.org` and `https://sepolia.base.org` both answer an underpriced EIP-1559 transaction from an empty account with `insufficient funds for gas * price + value: have 0 want 52500000000`. That want amount is `21000 * 2500000`. The same endpoints reject an includable fee the same way (`want 231000000000`). They did not return `max fee per gas less than block base fee` before the balance check.
- `npm test` covers underpriced fee construction, the 10% bump, the fee cap refusal, same-nonce EIP-1559 serialization, stuck-vs-mined polling, and RPC error classification.

Not verified live:

- An MPC signature. `npm run spike` stops at `result: evm-unfunded` before calling `sign`, so this environment did not spend NEAR gas or measure MPC latency.
- A funded underpriced transaction actually sitting in the mempool, and a same-nonce replacement landing. Every public Base Sepolia faucet found for this run requires a Coinbase, Alchemy, or QuickNode account (or an interactive claim). None of those credentials are in the environment.

### Blockers and the fallback

The open question is whether a funded transaction with `maxFeePerGas` below the 0.005 gwei floor is kept pending or rejected at ingress. Base's own docs say a low max fee stays pending until the base fee drops, and the minimum base fee means 0.0025 gwei can never be included. The unfunded probe shows the balance check runs on that low fee, which is what you would expect if the transaction is otherwise admissible. It does not prove the mempool keeps it.

If a funded run is rejected with `max fee per gas less than block base fee` (or a generic underpriced error), the script does not pretend the transaction is stuck. It signs one replacement at the same nonce, broadcasts only that transaction, and prints `result: fallback-ingress-rejected`. That still shows the MPC signature and an includable broadcast. It does not show a replacement of a pending transaction.

If `eth_sendRawTransaction` accepts the hash but neither the read RPC nor the sequencer ever returns it as pending, the script still broadcasts the replacement and prints `result: fallback-original-not-visible`.

If the fee required to get included would exceed `FEE_CAP_WEI`, the script prints `result: fee-cap` and does not sign. That is the pool-protection behavior this spike is here to prove out.
