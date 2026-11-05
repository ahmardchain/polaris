import { Account } from "@near-js/accounts";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import type { Action } from "@near-js/transactions";
import type { FinalExecutionOutcome } from "@near-js/types";
import { getTransactionLastResult } from "@near-js/utils";
import { chainAdapters, contracts, utils } from "chainsig.js";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import type { SpikeConfig } from "./config.js";
import { classifyBroadcastError, type BroadcastFailure } from "./errors.js";
import type { UnsignedPayment } from "./plan.js";

export interface DerivedAddress {
  address: Address;
  localPublicKey: string;
  contractPublicKey: string;
  contractUncompressed: string;
}

export function evmAddressFromUncompressed(uncompressed: string): Address {
  const body = uncompressed.startsWith("04") ? uncompressed.slice(2) : uncompressed;
  if (!/^[0-9a-fA-F]+$/.test(body) || body.length !== 128) {
    throw new Error("Expected a 64-byte uncompressed secp256k1 public key");
  }
  const hash = keccak256(`0x${body}`);
  return getAddress(`0x${hash.slice(-40)}`);
}

type MpcSignerAccount = Parameters<
  InstanceType<typeof contracts.ChainSignatureContract>["sign"]
>[0]["signerAccount"];

export function evmClients(config: SpikeConfig) {
  const readClient = createPublicClient({
    chain: config.chain.viemChain,
    transport: http(config.rpcUrl),
  });
  const sequencerClient = createPublicClient({
    chain: config.chain.viemChain,
    transport: http(config.submitUrl),
  });
  return { readClient, sequencerClient };
}

/** Inferred viem client. A `PublicClient` annotation clashes with the viem types bundled by chainsig.js. */
export type BaseClient = ReturnType<typeof evmClients>["readClient"];

export async function readBaseFee(client: BaseClient): Promise<bigint> {
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.baseFeePerGas == null) {
    throw new Error("Latest block has no baseFeePerGas");
  }
  return block.baseFeePerGas;
}

export async function suggestPriorityFee(client: BaseClient): Promise<bigint | undefined> {
  try {
    return await client.estimateMaxPriorityFeePerGas();
  } catch {
    return undefined;
  }
}

interface ExecutionStatus {
  status: unknown;
  transaction: { hash: string };
}

function hasSignatureResult(outcome: ExecutionStatus): boolean {
  const value = getTransactionLastResult(outcome as never);
  return value !== null && value !== undefined && value !== "";
}

function isFailure(outcome: ExecutionStatus): boolean {
  return (
    typeof outcome.status === "object" &&
    outcome.status !== null &&
    "Failure" in outcome.status
  );
}

/**
 * chainsig.js signs by calling `sign` on the MPC contract and reading the
 * yield/resume result off the NEAR transaction. Wait for FINAL, then poll,
 * so a slow MPC response is not mistaken for an empty result.
 */
export function mpcSignerAccount(account: Account, mpcWaitMs: number): MpcSignerAccount {
  return {
    accountId: account.accountId,
    async signAndSendTransactions(input) {
      const outcomes: FinalExecutionOutcome[] = [];
      for (const tx of input.transactions) {
        const started = Date.now();
        let outcome = (await account.signAndSendTransaction({
          receiverId: tx.receiverId,
          actions: tx.actions as Action[],
          waitUntil: "FINAL",
        })) as ExecutionStatus;

        while (!hasSignatureResult(outcome) && !isFailure(outcome)) {
          if (Date.now() - started > mpcWaitMs) {
            throw new Error(
              `MPC signature was not ready after ${mpcWaitMs}ms. NEAR transaction ${outcome.transaction.hash}. The sign call yields until the MPC network resumes it.`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          outcome = (await account.provider.txStatus(
            outcome.transaction.hash,
            account.accountId,
            "FINAL",
          )) as ExecutionStatus;
        }
        outcomes.push(outcome as FinalExecutionOutcome);
      }
      return outcomes;
    },
  };
}

export async function connectNear(
  config: SpikeConfig,
  accountId: string,
  privateKey: string,
): Promise<{
  account: Account;
  contract: InstanceType<typeof contracts.ChainSignatureContract>;
  provider: JsonRpcProvider;
  signerAccount: MpcSignerAccount;
}> {
  const keyPair = KeyPair.fromString(privateKey as KeyPairString);
  const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
  const account = new Account(accountId, provider, new KeyPairSigner(keyPair));
  const contract = new contracts.ChainSignatureContract({
    networkId: "testnet",
    contractId: config.mpcContractId,
    fallbackRpcUrls: [config.nearRpcUrl],
  });
  return {
    account,
    contract,
    provider,
    signerAccount: mpcSignerAccount(account, config.mpcWaitMs),
  };
}

export async function deriveAndVerify(input: {
  contract: InstanceType<typeof contracts.ChainSignatureContract>;
  provider: JsonRpcProvider;
  mpcContractId: string;
  predecessor: string;
  path: string;
  readClient: BaseClient;
}): Promise<DerivedAddress> {
  const evm = new chainAdapters.evm.EVM({
    publicClient: input.readClient as never,
    contract: input.contract,
  });
  const derived = await evm.deriveAddressAndPublicKey(input.predecessor, input.path);
  const contractKey = await input.provider.callFunction<string>(
    input.mpcContractId,
    "derived_public_key",
    {
      path: input.path,
      predecessor: input.predecessor,
      domain_id: 0,
    },
  );
  if (typeof contractKey !== "string" || !contractKey.startsWith("secp256k1:")) {
    throw new Error(
      `MPC contract ${input.mpcContractId} derived_public_key returned an unexpected value`,
    );
  }
  const uncompressed = utils.cryptography.najToUncompressedPubKeySEC1(
    contractKey as `secp256k1:${string}`,
  );
  const address = evmAddressFromUncompressed(uncompressed);
  if (getAddress(derived.address) !== address) {
    throw new Error(
      `Local derivation ${derived.address} does not match ${input.mpcContractId} view ${address}`,
    );
  }
  return {
    address,
    localPublicKey: derived.publicKey,
    contractPublicKey: contractKey,
    contractUncompressed: uncompressed,
  };
}

export interface SignedPayment {
  serialized: Hex;
  hash: Hash;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  mpcMs: number;
}

export async function signPayment(input: {
  readClient: BaseClient;
  contract: InstanceType<typeof contracts.ChainSignatureContract>;
  signerAccount: MpcSignerAccount;
  path: string;
  from: Address;
  payment: UnsignedPayment;
}): Promise<SignedPayment> {
  const evm = new chainAdapters.evm.EVM({
    publicClient: input.readClient as never,
    contract: input.contract,
  });
  const prepared = await evm.prepareTransactionForSigning({
    from: input.from,
    to: input.payment.to,
    value: input.payment.value,
    gas: input.payment.gas,
    nonce: input.payment.nonce,
    maxFeePerGas: input.payment.maxFeePerGas,
    maxPriorityFeePerGas: input.payment.maxPriorityFeePerGas,
  });
  const unsigned = prepared.transaction;
  if (unsigned.nonce !== input.payment.nonce) {
    throw new Error(
      `chainsig.js changed the nonce from ${input.payment.nonce} to ${unsigned.nonce}`,
    );
  }
  if (unsigned.maxFeePerGas !== input.payment.maxFeePerGas) {
    throw new Error("chainsig.js changed maxFeePerGas");
  }
  if (unsigned.maxPriorityFeePerGas !== input.payment.maxPriorityFeePerGas) {
    throw new Error("chainsig.js changed maxPriorityFeePerGas");
  }
  if (Number(unsigned.chainId) !== input.payment.chainId) {
    throw new Error(
      `chainsig.js chain id ${unsigned.chainId} does not match Base Sepolia ${input.payment.chainId}`,
    );
  }

  const started = Date.now();
  const signatures = await input.contract.sign({
    payloads: prepared.hashesToSign,
    path: input.path,
    keyType: "Ecdsa",
    signerAccount: input.signerAccount,
  });
  const serialized = evm.finalizeTransactionSigning({
    transaction: unsigned,
    rsvSignatures: signatures,
  });
  const parsed = parseTransaction(serialized);
  if (parsed.nonce !== input.payment.nonce) {
    throw new Error("Signed transaction nonce does not match the requested nonce");
  }
  const recovered = await recoverTransactionAddress({ serializedTransaction: serialized });
  if (getAddress(recovered) !== getAddress(input.from)) {
    throw new Error(
      `MPC signature recovered ${recovered}, expected derived address ${input.from}`,
    );
  }
  return {
    serialized,
    hash: keccak256(serialized),
    nonce: parsed.nonce,
    maxFeePerGas: parsed.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
    mpcMs: Date.now() - started,
  };
}

export async function broadcastSigned(
  client: BaseClient,
  serialized: Hex,
): Promise<{ ok: true; hash: Hash } | { ok: false; failure: BroadcastFailure }> {
  try {
    const hash = await client.sendRawTransaction({ serializedTransaction: serialized });
    return { ok: true, hash };
  } catch (error) {
    return { ok: false, failure: classifyBroadcastError(error) };
  }
}
