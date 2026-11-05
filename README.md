# polaris

Other entry by same author: TBD

Track: `agents`

Do this to see a NEAR account buy a guarantee for a 1 wei Ethereum Sepolia payment, then either prove delivery after a same-nonce fee bump or claim a refund when the deadline passes.

The guarantee contract is `guarantee.polaris-d1-z7npttup.testnet`. The owner is `polaris-d1-z7npttup.testnet`. The checker is `checker.polaris-d1-z7npttup.testnet`. The checker is a normal NEAR account set with `set_checker`. It is trusted. It is not a TEE, and the contract does not verify the Sepolia transaction. The premium is a flat 0.1 NEAR. A claim pays NEAR. The page also requests a dry NEAR Intents quote for an optional USDC-on-Base delivery of that claim. No live swap was sent. The current wasm, including `get_guarantees` and the validation events, was deployed in `2zcgJGeQWWZcUMS4VpmZGeP1A8oGX5aNkmrEhNKj1Hwc` without calling `new` again.

## See the guarantees

```bash
cd web
npm install
npm test
npm run dev
```

Open http://localhost:5173. The page reads the contract from NEAR testnet. Scenario A and B cards link to the Sepolia and NEAR transactions below. The buy form refuses coverage the pool cannot pay and copies a `near` command. The page does not hold a key.

`web` tests: status labels and the pool-cap check. `npm test` there.

## Run the other tests

```bash
cd contract && cargo test
cd ../spike && npm test
cd ../checker && npm test
```

Contract tests: 17 passed (delivered, timeout refund, late proof, cap, double claim, wrong checker, early claim, owner-only `set_checker`, chain and hash validation, 30-day deadline, empty fund, surplus withdraw, `get_guarantees`, buy event). Spike tests: 18 passed (fee bump, fee cap, same nonce). Checker tests: 16 passed, with mocked NEAR and Sepolia plus dry 1-Click quote parsing. `cd checker && npm run quote` hits the live 1-Click API with `dry: true`.

## Reproduce scenarios A and B

Put `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY` in `spike/.env`. Put `CHECKER_ACCOUNT` and `CHECKER_PRIVATE_KEY` in `checker/.env` (`npm run set-checker` writes them). `EVM_CHAIN=ethereum-sepolia`.

```bash
cd checker
npm install
npm run fund-pool
npm run demo
```

`npm run demo` buys two guarantees, sends the Sepolia payments through `spike/`, fee-bumps only when the replacement still fits under `FEE_CAP_WEI` and can confirm before the deadline, then either calls `submit_proof` or leaves the guarantee so `claim` pays the agent.

To point the contract at a new checker account:

```bash
cd checker
npm run set-checker
```

That created `checker.polaris-d1-z7npttup.testnet` (`6UXaMn7HKj2iztWX52HjGJNmbXgAcaGbKmpTfMUyKy2j`) and called `set_checker` (`FtD73YU32o1Z5Fjn1ZuCRCA6NBap78tcDXnsJarSEKTZ`). The key stays in `checker/.env`.

## Transactions

Pool fund, 0.001 NEAR: [`DRo6MS2L5Hf1k1rQYgbCRv3deNBFVBiG6HzonHk71EHu`](https://testnet.nearblocks.io/txns/DRo6MS2L5Hf1k1rQYgbCRv3deNBFVBiG6HzonHk71EHu).

Coverage on the demo guarantees is 0.0002 NEAR. The destination amount recorded on each is 1 wei. The derived payer is `0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6`.

### A. Stuck, fee-bumped, Delivered

Guarantee 3. Underpriced nonce 3 (`maxFeePerGas` 3 wei) was pending for 28449 ms. The replacement mined in block 12067942 with 2 confirmations. MPC: underpriced 26792 ms, replacement 16210 ms.

| Step | Hash |
| --- | --- |
| Buy | [`4dCwev8mrQaZtV5q1Pz5wTjFPsryxf17r8Rm2Z2LUo3E`](https://testnet.nearblocks.io/txns/4dCwev8mrQaZtV5q1Pz5wTjFPsryxf17r8Rm2Z2LUo3E) |
| Underpriced | [`0x2e73d90c91a00fecf935a78f04b92164ba36591e1db04617c01a6d210774085b`](https://sepolia.etherscan.io/tx/0x2e73d90c91a00fecf935a78f04b92164ba36591e1db04617c01a6d210774085b) |
| Replacement, same nonce | [`0x4546eed3b02239a3bea9646ea3ddf59b8b82787d726effe92662c8bd67e5ba9e`](https://sepolia.etherscan.io/tx/0x4546eed3b02239a3bea9646ea3ddf59b8b82787d726effe92662c8bd67e5ba9e) |
| submit_proof | [`4m8SUbbX7dW2mbBpUyzGYsrGxNNDN568CQoHRaJC1mfZ`](https://testnet.nearblocks.io/txns/4m8SUbbX7dW2mbBpUyzGYsrGxNNDN568CQoHRaJC1mfZ) |

### B. Deadline passed, Claimed

Guarantee 4. Underpriced nonce 4 stayed pending for 84141 ms (MPC 15605 ms). No proof. Claim paid 0.0002 NEAR to the agent.

| Step | Hash |
| --- | --- |
| Buy | [`GF3AVqCDHHYhrVjnoD6Ewq5AuMwEKeHZiDAxwPPnQcLM`](https://testnet.nearblocks.io/txns/GF3AVqCDHHYhrVjnoD6Ewq5AuMwEKeHZiDAxwPPnQcLM) |
| Underpriced, not proved | [`0x03cc5ec7c877007e020e507ad838bd76f704538d87ff5d983aa6d783265ac2d9`](https://sepolia.etherscan.io/tx/0x03cc5ec7c877007e020e507ad838bd76f704538d87ff5d983aa6d783265ac2d9) |
| claim | [`5onvRo1TirhoLTW9NY9adyyGqXxxMame9QdkMkSoEcfi`](https://testnet.nearblocks.io/txns/5onvRo1TirhoLTW9NY9adyyGqXxxMame9QdkMkSoEcfi) |
| Nonce recovery only, not a proof | [`0xbee7cb84d992c61e5379dd60dad9ab488e35f0c9b385774cc45b201a093908ab`](https://sepolia.etherscan.io/tx/0xbee7cb84d992c61e5379dd60dad9ab488e35f0c9b385774cc45b201a093908ab) |

## Optional Base USDC payout

A claim still pays NEAR on testnet. To preview sending that payout as USDC on Base, ask NEAR Intents 1-Click for a dry quote. `dry: true` returns amounts and does not create a `depositAddress`. There is no Intents testnet. This repo did not send a live swap.

```bash
cd checker
npm run quote
```

On 5 Nov 2026 `npm run quote` for 0.0002 wNEAR to Base USDC returned `Quoting for this pair is not available` (correlation `380e5cc6-58a3-46dc-b94c-66cb7a0a3122`). The same call for 1 USDC on Ethereum to USDC on Base returned `0.997497` USDC, about $0.997, 47 seconds, deposit address null because `dry` was true (correlation `881b37ad-d537-4225-b5ff-af6ec3aa4c20`). The web page shows both.

A mainnet tiny path, not run here: repeat that request with `"dry": false` and `INTENTS_ALLOW_LIVE=true`, then transfer the quoted origin amount to `depositAddress` before `deadline`. Use an amount you can afford to lose. Do not point `refundTo` at an address on the wrong chain.

## Limits

- The checker is trusted. Anyone who has `checker.polaris-d1-z7npttup.testnet` can call `submit_proof`. The contract does not check the Sepolia receipt.
- The premium is NEAR. A testnet claim pays NEAR. The Base USDC path is a dry 1-Click quote only. wNEAR to Base USDC was not quotable when checked; 1 ETH USDC to Base USDC was. No `dry: false` swap was sent.
- PublicNode sometimes returns `transaction underpriced` for a 3 wei `maxFeePerGas` and accepts a retry of the same signed transaction.
- A frontend demo video script is `docs/demo.md`. The video is not recorded here.
- There is no separate product UI beyond `web/`.
- The repo is public at https://github.com/ahmardchain/polaris. The license is MIT, in `LICENSE`.
