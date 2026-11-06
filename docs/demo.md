# Demo video

About one minute. Screen record the live page https://polaris-5pj.pages.dev, or the same UI from `web/` on `npm run dev` (http://localhost:5173/polaris/), then the two explorer links. No background music.

Do open the page - see contract `guarantee.polaris-d1-z7npttup.testnet`, scenario A, scenario B, and the dry 1-Click panel.

1. Open the app. Say the contract is `guarantee.polaris-d1-z7npttup.testnet`. Point at the owner `polaris-d1-z7npttup.testnet` and the checker `checker.polaris-d1-z7npttup.testnet`. Say the checker is a normal NEAR account, not a TEE.
2. Point at the premium (0.1 NEAR) and the pool balance. Say the premium is NEAR and a claim pays NEAR. Point at the dry 1-Click panel and say NEAR Intents payouts are dry-run quotes only: `dry: true`, no deposit address, no swap sent.
3. Open scenario A. Status is Delivered. Click the fee-bumped Sepolia transaction `0x4546eed3b02239a3bea9646ea3ddf59b8b82787d726effe92662c8bd67e5ba9e` and the NEAR proof `4m8SUbbX7dW2mbBpUyzGYsrGxNNDN568CQoHRaJC1mfZ`. Say the underpriced transaction sat pending for 28449 ms, then the same nonce was replaced.
4. Open scenario B. Status is Claimed. Click the claim `5onvRo1TirhoLTW9NY9adyyGqXxxMame9QdkMkSoEcfi`. Say no proof was submitted because the deadline passed while the payment was still pending. Mention the Sepolia recovery transfer only freed the nonce.
5. In the buy form, type coverage `1` and show the pool-cap refusal. Set coverage back to `0.0002` and show the copied `near` command. Say the page does not hold a key.

Stop. Do not show `.env` or a private key.
