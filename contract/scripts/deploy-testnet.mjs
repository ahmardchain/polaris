/**
 * Deploy polaris-guarantee to NEAR testnet.
 *
 * Reads NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY from the environment or from
 * spike/.env. Never prints the key.
 *
 * CONTRACT_ACCOUNT defaults to guarantee.<NEAR_ACCOUNT_ID>.
 * CHECKER_ACCOUNT defaults to NEAR_ACCOUNT_ID. The checker is a normal
 * NEAR account the owner can replace. It is not a TEE.
 * PREMIUM_YOCTO defaults to 0.1 NEAR.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators } from "@near-js/transactions";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const wasmPath = resolve(
  here,
  "../target/wasm32-unknown-unknown/release/polaris_guarantee.wasm",
);

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(resolve(root, "spike/.env"));
loadEnvFile(resolve(root, ".env"));

const accountId = process.env.NEAR_ACCOUNT_ID;
const privateKey = process.env.NEAR_PRIVATE_KEY;
const rpcUrl = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const contractId = process.env.CONTRACT_ACCOUNT || `guarantee.${accountId}`;
const checkerId = process.env.CHECKER_ACCOUNT || accountId;
const premium = process.env.PREMIUM_YOCTO || "100000000000000000000000";
const gas = 80_000_000_000_000n;

if (!accountId || !privateKey) {
  console.error("NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY are required.");
  process.exit(1);
}
if (!existsSync(wasmPath)) {
  console.error(`WASM not found at ${wasmPath}. Run cargo build --release --target wasm32-unknown-unknown first.`);
  process.exit(1);
}

const wasm = new Uint8Array(readFileSync(wasmPath));
const provider = new JsonRpcProvider({ url: rpcUrl });
const signer = new KeyPairSigner(KeyPair.fromString(privateKey));
const owner = new Account(accountId, provider, signer);

async function accountExists(id) {
  try {
    await provider.query({
      request_type: "view_account",
      account_id: id,
      finality: "final",
    });
    return true;
  } catch {
    return false;
  }
}

async function isInitialized(id) {
  try {
    await provider.callFunction(id, "get_config", {});
    return true;
  } catch {
    return false;
  }
}

const initArgs = { checker: checkerId, premium };

if (!(await accountExists(contractId))) {
  console.log(`Creating ${contractId} and deploying the guarantee contract.`);
  const outcome = await owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actionCreators.createAccount(),
      actionCreators.transfer(5n * 10n ** 24n),
      actionCreators.addKey(await signer.getPublicKey(), actionCreators.fullAccessKey()),
      actionCreators.deployContract(wasm),
      actionCreators.functionCall("new", initArgs, gas, 0n),
    ],
    waitUntil: "FINAL",
  });
  console.log(`created: ${outcome.transaction.hash}`);
} else {
  console.log(`Deploying to existing account ${contractId}.`);
  const outcome = await owner.signAndSendTransaction({
    receiverId: contractId,
    actions: [actionCreators.deployContract(wasm)],
    waitUntil: "FINAL",
  });
  console.log(`deployed: ${outcome.transaction.hash}`);
  if (!(await isInitialized(contractId))) {
    const initOutcome = await owner.callFunctionRaw({
      contractId,
      methodName: "new",
      args: initArgs,
      gas,
      waitUntil: "FINAL",
    });
    console.log(`initialized: ${initOutcome.transaction.hash}`);
  } else {
    console.log("contract state already initialized; left it in place");
  }
}

const config = await provider.callFunction(contractId, "get_config", {});
const pool = await provider.callFunction(contractId, "get_pool", {});
console.log(`contract: ${contractId}`);
console.log(`owner: ${config.owner}`);
console.log(`checker: ${config.checker}`);
console.log(`premium yocto: ${config.premium}`);
console.log(`pool balance yocto: ${pool.pool_balance}`);
console.log(`outstanding coverage yocto: ${pool.outstanding_coverage}`);
