import "./env.js";
import { requireSigner, loadConfig } from "../../spike/src/config.js";
import { connectNear, deriveAndVerify, evmClients } from "../../spike/src/chain.js";
import { createEvmPort } from "./evm-payment.js";
import { createGuaranteeClient, type GuaranteeClient } from "./near-guarantee.js";
import type { EvmPort } from "./service.js";

export interface Session {
  guarantee: GuaranteeClient;
  evm: EvmPort;
  from: `0x${string}`;
  chainName: string;
  chainId: number;
  paymentTo: string;
  paymentWei: bigint;
  feeCapWei: bigint;
}

export async function openSession(): Promise<Session> {
  const config = loadConfig();
  const signer = requireSigner(config);
  if (!config.chain.key) {
    throw new Error("EVM_CHAIN is not set");
  }
  const near = await connectNear(config, signer.nearAccountId, signer.nearPrivateKey);
  const { readClient, sequencerClient } = evmClients(config);
  const derived = await deriveAndVerify({
    contract: near.contract,
    provider: near.provider,
    mpcContractId: config.mpcContractId,
    predecessor: signer.nearAccountId,
    path: config.derivationPath,
    readClient,
  });
  const chainId = await readClient.getChainId();
  if (chainId !== config.chain.chainId) {
    throw new Error(`RPC chain id ${chainId} is not ${config.chain.name} (${config.chain.chainId})`);
  }
  const contractId =
    process.env.GUARANTEE_CONTRACT?.trim() || "guarantee.polaris-d1-z7npttup.testnet";
  return {
    guarantee: createGuaranteeClient({
      account: near.account,
      provider: near.provider,
      contractId,
    }),
    evm: createEvmPort({
      config,
      readClient,
      submitClient: sequencerClient,
      from: derived.address,
      signing: {
        contract: near.contract,
        signerAccount: near.signerAccount,
        path: config.derivationPath,
      },
    }),
    from: derived.address,
    chainName: config.chain.name,
    chainId,
    paymentTo: config.paymentTo,
    paymentWei: config.paymentWei,
    feeCapWei: config.feeCapWei,
  };
}
