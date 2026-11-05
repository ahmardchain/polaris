/**
 * Create checker.<owner> on testnet and point the guarantee contract at it.
 * The new key is written to checker/.env and is not printed.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";
import "./env.js";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "../.env");
const contractId = process.env.GUARANTEE_CONTRACT?.trim() || "guarantee.polaris-d1-z7npttup.testnet";
const ownerId = process.env.NEAR_ACCOUNT_ID?.trim();
const ownerKey = process.env.NEAR_PRIVATE_KEY?.trim();
const rpcUrl = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const gas = 30_000_000_000_000n;
const stake = 500_000_000_000_000_000_000_000n;

if (!ownerId || !ownerKey) {
  throw new Error("NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY are required");
}

const provider = new JsonRpcProvider({ url: rpcUrl });
const owner = new Account(ownerId, provider, new KeyPairSigner(KeyPair.fromString(ownerKey as KeyPairString)));
const checkerId = process.env.CHECKER_ACCOUNT?.trim() || `checker.${ownerId}`;

async function exists(id: string): Promise<boolean> {
  try {
    await provider.query({ request_type: "view_account", account_id: id, finality: "final" });
    return true;
  } catch {
    return false;
  }
}

function remember(accountId: string, secret: string | undefined): void {
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const kept = lines.filter(
    (line) => line.trim() && !line.startsWith("CHECKER_ACCOUNT=") && !line.startsWith("CHECKER_PRIVATE_KEY="),
  );
  if (secret) {
    kept.push(`CHECKER_ACCOUNT=${accountId}`, `CHECKER_PRIVATE_KEY=${secret}`);
  } else if (!kept.some((line) => line.startsWith("CHECKER_ACCOUNT="))) {
    kept.push(`CHECKER_ACCOUNT=${accountId}`);
  }
  writeFileSync(envPath, `${kept.join("\n")}\n`);
}

let savedSecret = process.env.CHECKER_PRIVATE_KEY?.trim();
if (!(await exists(checkerId))) {
  const key = KeyPair.fromRandom("ed25519");
  savedSecret = key.toString();
  console.log(`creating ${checkerId}`);
  const created = await owner.signAndSendTransaction({
    receiverId: checkerId,
    actions: [
      actionCreators.createAccount(),
      actionCreators.transfer(stake),
      actionCreators.addKey(key.getPublicKey(), actionCreators.fullAccessKey()),
    ],
    waitUntil: "FINAL",
  });
  console.log(`created: ${created.transaction.hash}`);
} else {
  console.log(`${checkerId} already exists`);
}

const updated = await owner.callFunctionRaw({
  contractId,
  methodName: "set_checker",
  args: { checker: checkerId },
  gas,
  waitUntil: "FINAL",
});
remember(checkerId, savedSecret);
const config = (await provider.callFunction(contractId, "get_config", {})) as {
  owner: string;
  checker: string;
};
console.log(`set_checker: ${updated.transaction.hash}`);
console.log(`owner: ${config.owner}`);
console.log(`checker: ${config.checker}`);
if (config.checker !== checkerId) {
  throw new Error(`on-chain checker is ${config.checker}, expected ${checkerId}`);
}
if (config.checker === config.owner) {
  throw new Error("checker is still the owner");
}
