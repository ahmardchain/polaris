# polaris

Polaris sends an AI agent's cross-chain payment via NEAR Chain Signatures with an on-time guarantee. A NEAR contract pays out by default at the deadline unless Polaris submits delivery proof. Polaris bumps fees on its own stuck transactions to protect its pool.

Other entry by same author: TBD

## Guarantee contract

`contract/` is a Rust contract (`near-sdk` 5.30) for the guarantee itself.

An agent calls `buy_guarantee` and attaches the flat premium in NEAR. The call records the destination chain, the recipient, the destination payment amount (in that chain's units, such as wei), the NEAR `coverage` the pool will pay if delivery is not proved, and a deadline. The premium is NEAR for this version. Charging USDC is a later change.

The pool is the contract's NEAR reserved for payouts. `fund_pool` adds capital. A purchase is refused when outstanding coverage plus the new coverage would exceed the pool balance after the premium is added. On delivery, the coverage is released and the premium stays in the pool. After the deadline, anyone can call `claim` and the agent is paid `coverage` from the pool. A second claim is rejected. A proof submitted at or after the deadline is rejected.

The owner sets `checker`, the only account that can call `submit_proof` with the destination transaction hash. That checker is a normal NEAR account the owner can replace. It is trusted. It is not a TEE, and the contract does not verify the destination transaction itself.

Deployed on NEAR testnet as `guarantee.polaris-d1-z7npttup.testnet`. The owner and the checker are both `polaris-d1-z7npttup.testnet`. The flat premium is 0.1 NEAR. The pool balance is 0 until someone calls `fund_pool`, so a purchase with coverage above that premium is refused until the pool is capitalized. The deploy transaction was `6369XPUeWCmrkLWCWYCBm74h58v3tzLDBXuVBytHZnrS`.

```bash
cd contract
cargo test
./scripts/deploy-testnet.sh
```

`scripts/deploy-testnet.sh` builds the wasm and deploys with the NEAR account in `spike/.env`. It does not print the key. `CONTRACT_ACCOUNT`, `CHECKER_ACCOUNT`, and `PREMIUM_YOCTO` override the defaults.

Unit tests cover delivery (premium stays, coverage released), a timeout claim, a late proof, a purchase over the pool cap, a second claim, a proof from the wrong account, a claim before the deadline, and an owner-only checker change. `cargo test`: 10 passed.

## Day-1 spike

`spike/` is the day-1 risk check. It derives an EVM address from a NEAR testnet account, broadcasts an intentionally underpriced EIP-1559 payment, watches whether that payment stays pending, then replaces it at the same nonce with a higher fee that stays under a configurable cap.

`EVM_CHAIN` selects the destination. `base-sepolia` (chain id `84532`) is the default. `ethereum-sepolia` (chain id `11155111`) is the chain used for the live run below, because that is where the derived address was funded.

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

The script asks the contract to sign, waits for `FINAL`, and polls until `MPC_WAIT_MS` (default 180s). The `sign` method yields until the MPC network resumes it.

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
| `EVM_CHAIN` | no | `base-sepolia` (default) or `ethereum-sepolia` |
| `EVM_RPC_URL` | no | Read RPC. Defaults to the chain's public endpoint |
| `EVM_SUBMIT_URL` | no | `eth_sendRawTransaction`. On Base this is the sequencer. On Ethereum Sepolia it defaults to the same public RPC |
| `BASE_SEPOLIA_RPC_URL` / `BASE_SEPOLIA_SEQUENCER_URL` | no | Still honored when `EVM_CHAIN=base-sepolia` |
| `FEE_CAP_WEI` | no | Hard ceiling for the replacement. Default `1000000000` (1 gwei). The script refuses to sign above it |
| `REPLACEMENT_BUMP_BPS` | no | Bump over the stuck fees. Default `1000` (10%) |
| `DERIVATION_PATH` | no | Default `polaris-base-sepolia`. This selects the key, not the destination chain |
| `MPC_CONTRACT_ID` | no | Default `v1.signer-prod.testnet` |
| `PAYMENT_TO` / `PAYMENT_WEI` | no | Default is 1 wei to the burn address |
| `STUCK_WAIT_MS` | no | How long to watch a pending underpriced hash. Unset uses 12s on Base and 36s on Ethereum |

Create the NEAR account with the faucet if you do not have one:

```bash
near create-account <name>.testnet --useFaucet
```

The account needs a fraction of a NEAR for gas. Two `sign` calls are the expensive part. The EVM key never exists locally; only the MPC network can sign for the derived address.

The derivation path is part of the key. `polaris-d1-z7npttup.testnet` with path `polaris-base-sepolia` is `0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6` on every EVM chain. Keep that path if you are spending from the address that was funded.

### Fund the derived address

`npm run dry-run` prints `derivedAddress` and the selected chain without signing or broadcasting. Send native ETH on that chain to the address.

Base Sepolia faucets (each rate-limits claims; Coinbase, Alchemy, and QuickNode require an account):

- [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet)
- [Alchemy Base Sepolia faucet](https://www.alchemy.com/faucets/base-sepolia)
- [QuickNode Base Sepolia faucet](https://faucet.quicknode.com/base/sepolia)
- [ethfaucet.com Base Sepolia](https://ethfaucet.com/networks/base/base-sepolia)

Ethereum Sepolia: the [Google Cloud faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) and other Sepolia faucets. A drip of 0.05 ETH is more than enough for this 1 wei transfer. On Base, also leave room for the L1 data fee; 0.0001 ETH is enough there.

The script stops before any MPC call when the address cannot cover `PAYMENT_WEI + 21000 * replacement maxFeePerGas`.

### Commands

```bash
cd spike
npm test                 # no network, no keys
npm run dry-run          # live base fee + live MPC derived_public_key view, no broadcast
npm run probe:ingress    # unfunded throwaway key against the selected chain
npm run spike            # full path: sign, broadcast, wait, replace
```

Ethereum Sepolia:

```bash
EVM_CHAIN=ethereum-sepolia npm run spike
```

### Live result on Ethereum Sepolia

Run on 5 Nov 2026 with `EVM_CHAIN=ethereum-sepolia`, path `polaris-base-sepolia`, and `FEE_CAP_WEI=1000000000`. The address had been funded with 0.05 ETH on Ethereum Sepolia (chain id `11155111`), not Base. Balance before the run was `50000000000000000` wei. The base fee was `17` wei. The primary path completed. No fallback was used.

The underpriced transaction used `maxFeePerGas` `3` wei, which is under Ethereum's practical 7 wei floor (EIP-1559 decreases the base fee by `parent/8`, so it cannot fall below 7 wei). The public RPC accepted it. It stayed pending for `36063` ms, across blocks `12066192` through `12066195`, and `eth_getTransactionByHash` returned it with no block number during that wait.

The replacement, signed at the same nonce, used `maxFeePerGas` `1000034` wei and `maxPriorityFeePerGas` `1000000` wei, both under the 1 gwei cap. It mined successfully in block `12066198`. The account nonce is now `1`. The underpriced hash has no receipt; the node dropped it when the replacement landed, so a later lookup returns null. Etherscan may have no page for a dropped hash. The replacement page is the receipt.

| | Underpriced | Replacement |
| --- | --- | --- |
| Hash | [`0xe840e6e4c91a125e3b59ae332c80f4b4755da637447ed225d7cc1024f06eae64`](https://sepolia.etherscan.io/tx/0xe840e6e4c91a125e3b59ae332c80f4b4755da637447ed225d7cc1024f06eae64) | [`0x1cfacb5d7c4bdcdca4f3f9d4bb1f3dd1584325168db7cb04e0daf6865658c159`](https://sepolia.etherscan.io/tx/0x1cfacb5d7c4bdcdca4f3f9d4bb1f3dd1584325168db7cb04e0daf6865658c159) |
| Nonce | `0` | `0` |
| maxFeePerGas | `3` wei | `1000034` wei |
| maxPriorityFeePerGas | `1` wei | `1000000` wei |
| MPC sign | `27764` ms | `29959` ms |
| Outcome | Pending for 36.1s, then dropped | Success in block `12066198` |

```text
chain: Ethereum Sepolia
chainId: 11155111
nonceEqual: true
underpriced.observation: pending
underpriced.sawPending: true
underpriced.pendingForMs: 36063
replacement.status: success
replacement.block: 12066198
underpriced.mined: no
result: replaced
```

The run log said `accepted via sequencer`. That label was the submit endpoint. On this chain the submit URL was `https://ethereum-sepolia-rpc.publicnode.com`, the same node used for reads. Later runs print `submit` for that field.

### Base Sepolia shape

With the Base base fee at its 0.005 gwei floor (`5000000` wei), the same script builds:

| Transaction | maxFeePerGas | maxPriorityFeePerGas |
| --- | --- | --- |
| Underpriced | `2500000` wei, half the chain minimum, so it cannot be included while the floor holds | `1` wei |
| Replacement | `11000000` wei when the suggested tip is `1000000` wei | `1000000` wei |

Both are EIP-1559 on chain id `84532`, same nonce, under the same 1 gwei cap. A dry run on 5 Nov 2026 confirmed that plan and the derivation, with a zero Base balance. An unfunded probe of `https://sepolia.base.org` and `https://sepolia-sequencer.base.org` returned `insufficient funds` (`want 52500000000` for the underpriced fee, which is `21000 * 2500000`) rather than `max fee per gas less than block base fee`. A funded Base broadcast has not been run.

### What this run did and did not show

Showed live:

- Derivation for `polaris-d1-z7npttup.testnet` + `polaris-base-sepolia` matches `v1.signer-prod.testnet` `derived_public_key`. Address `0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6`.
- Two MPC signatures on Ethereum Sepolia, `27.8s` and `30.0s`.
- The underpriced transaction sat pending for `36.1s` and three blocks.
- The same-nonce replacement mined. `result: replaced`. Nonces equal. Fee cap held.

Did not show:

- The same flow on Base Sepolia with a funded address. Base support remains in `EVM_CHAIN=base-sepolia`.
- A case where the node rejects the underpriced transaction at ingress. If that happens, the script signs one includable transaction at the same nonce and prints `result: fallback-ingress-rejected`. That is a broadcast of the bumped fee, not a replacement of a transaction that was sitting in the pool.
- A case where the fee required to get included exceeds `FEE_CAP_WEI`. The script then prints `result: fee-cap` and does not sign.

## Checker service

`checker/` buys a guarantee, sends the Sepolia payment with the spike's Chain Signatures path, and decides what to do next.

It signs an underpriced EIP-1559 transaction. If that transaction is still pending after the stuck window, and a same-nonce replacement fits under `FEE_CAP_WEI` and can still be signed and confirmed before the deadline, it fee-bumps. Once the landed transaction has the required confirmations and the deadline has not passed, it calls `submit_proof` with that hash. If it cannot land in time, it does not submit proof, so `claim` can refund the agent after the deadline. The checker account is still the trusted owner key. It is not a TEE.

```bash
cd checker
npm install
npm test
npm run fund-pool
npm run demo          # scenario A, then scenario B
```

`npm test`: 12 passed. The tests mock NEAR and Sepolia and cover the fee bump, the fee cap, a deadline that is too soon to rescue, and a claim that does not run after proof.

The pool was funded with `0.001` NEAR in `DRo6MS2L5Hf1k1rQYgbCRv3deNBFVBiG6HzonHk71EHu`. Each guarantee pays the contract's flat premium of 0.1 NEAR and covers `0.0002` NEAR (`200000000000000000000` yocto). The destination payment recorded on the guarantee is 1 wei.

### Scenario A, stuck payment rescued

Guarantee 3. The underpriced transaction (nonce 3, `maxFeePerGas` 3 wei) was seen pending for 28.4 seconds. The replacement at the same nonce mined in block `12067942` with 2 confirmations. `submit_proof` stored that hash. The underpriced hash was then dropped.

| Step | Hash |
| --- | --- |
| Buy | [`4dCwev8mrQaZtV5q1Pz5wTjFPsryxf17r8Rm2Z2LUo3E`](https://testnet.nearblocks.io/txns/4dCwev8mrQaZtV5q1Pz5wTjFPsryxf17r8Rm2Z2LUo3E) |
| Underpriced, pending 28449 ms, MPC 26792 ms | [`0x2e73d90c…4085b`](https://sepolia.etherscan.io/tx/0x2e73d90c91a00fecf935a78f04b92164ba36591e1db04617c01a6d210774085b) |
| Replacement, nonce 3, MPC 16210 ms, success | [`0x4546eed3…5ba9e`](https://sepolia.etherscan.io/tx/0x4546eed3b02239a3bea9646ea3ddf59b8b82787d726effe92662c8bd67e5ba9e) |
| Proof | [`4m8SUbbX7dW2mbBpUyzGYsrGxNNDN568CQoHRaJC1mfZ`](https://testnet.nearblocks.io/txns/4m8SUbbX7dW2mbBpUyzGYsrGxNNDN568CQoHRaJC1mfZ) |

Guarantee 3 is `Delivered`. Its proof hash is the replacement. An earlier pass, guarantee 1, proved [`0xa0a9e2d4…5ba9e`](https://sepolia.etherscan.io/tx/0xa0a9e2d4867534d576fc599674df1b840a9f8a0cb1219f193eac5316892e2548) only after PublicNode rejected the underpriced broadcast, so that pass did not show a transaction sitting pending. Guarantee 3 is the stuck-then-rescue run.

### Scenario B, deadline passes and claim pays

Guarantee 4. The underpriced transaction (nonce 4, `maxFeePerGas` 3 wei) stayed pending for 84.1 seconds. A bump would not have confirmed before the deadline, so no proof was submitted. After the deadline, `claim` paid the 0.0002 NEAR coverage to `polaris-d1-z7npttup.testnet`. Status is `Claimed` and `proof_tx_hash` is null.

| Step | Hash |
| --- | --- |
| Buy | [`GF3AVqCDHHYhrVjnoD6Ewq5AuMwEKeHZiDAxwPPnQcLM`](https://testnet.nearblocks.io/txns/GF3AVqCDHHYhrVjnoD6Ewq5AuMwEKeHZiDAxwPPnQcLM) |
| Underpriced, pending 84141 ms, MPC 15605 ms, not proved | [`0x03cc5ec7…ac2d9`](https://sepolia.etherscan.io/tx/0x03cc5ec7c877007e020e507ad838bd76f704538d87ff5d983aa6d783265ac2d9) |
| Claim | [`5onvRo1TirhoLTW9NY9adyyGqXxxMame9QdkMkSoEcfi`](https://testnet.nearblocks.io/txns/5onvRo1TirhoLTW9NY9adyyGqXxxMame9QdkMkSoEcfi) |

The underpriced nonce was still open after the claim, which would block later payments. The demo then broadcast a same-nonce transfer, [`0xbee7cb84…908ab`](https://sepolia.etherscan.io/tx/0xbee7cb84d992c61e5379dd60dad9ab488e35f0c9b385774cc45b201a093908ab), mined in block `12067963`. That was only to free the account. `submit_proof` was not called, and the guarantee stayed `Claimed`.

PublicNode sometimes answers the first underpriced broadcast with `transaction underpriced` and accepts a retry. The sender retries the same signed transaction, and signs once more if the retries are still rejected.

## What is left

A frontend and a demo video are not in this repo. The payout is NEAR from the pool. A NEAR Intents payout, and USDC premiums, are not implemented. The checker is still the owner's key, not a separate service account or a TEE.
