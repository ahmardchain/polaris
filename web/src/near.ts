import { CONTRACT_ID } from "./demo-data.ts";

export interface ConfigView {
  owner: string;
  checker: string;
  premium: bigint;
}

export interface PoolView {
  poolBalance: bigint;
  outstandingCoverage: bigint;
  freeCoverage: bigint;
  premium: bigint;
}

export interface GuaranteeView {
  id: number;
  agent: string;
  destinationChain: string;
  recipient: string;
  amount: string;
  coverage: bigint;
  deadline: bigint;
  status: "Open" | "Delivered" | "Claimed";
  proofTxHash: string | null;
}

function rpcUrl(): string {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return "/near-rpc";
  }
  return "https://rpc.testnet.near.org";
}

async function view<T>(method: string, args: object): Promise<T> {
  const response = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "polaris",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT_ID,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`NEAR RPC HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    error?: { message?: string };
    result?: { result?: number[] };
  };
  if (body.error) {
    throw new Error(body.error.message ?? "NEAR RPC error");
  }
  const bytes = body.result?.result;
  if (!bytes) {
    throw new Error(`empty result from ${method}`);
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
}

function asBigint(value: string | number): bigint {
  return BigInt(value);
}

function asStatus(value: unknown): GuaranteeView["status"] {
  if (value === "Open" || value === "Delivered" || value === "Claimed") {
    return value;
  }
  throw new Error(`unexpected status ${JSON.stringify(value)}`);
}

export async function loadChain(): Promise<{
  config: ConfigView;
  pool: PoolView;
  guarantees: GuaranteeView[];
}> {
  const [configRaw, poolRaw] = await Promise.all([
    view<{ owner: string; checker: string; premium: string }>("get_config", {}),
    view<{
      pool_balance: string;
      outstanding_coverage: string;
      free_coverage: string;
      premium: string;
    }>("get_pool", {}),
  ]);

  try {
    const listed = await view<Array<{ id: number; guarantee: {
      agent: string;
      destination_chain: string;
      recipient: string;
      amount: string;
      coverage: string;
      deadline: string;
      status: unknown;
      proof_tx_hash: string | null;
    } }>>("get_guarantees", { from_index: 0, limit: 50 });
    return {
      config: {
        owner: configRaw.owner,
        checker: configRaw.checker,
        premium: asBigint(configRaw.premium),
      },
      pool: {
        poolBalance: asBigint(poolRaw.pool_balance),
        outstandingCoverage: asBigint(poolRaw.outstanding_coverage),
        freeCoverage: asBigint(poolRaw.free_coverage),
        premium: asBigint(poolRaw.premium),
      },
      guarantees: listed.map((entry) => ({
        id: entry.id,
        agent: entry.guarantee.agent,
        destinationChain: entry.guarantee.destination_chain,
        recipient: entry.guarantee.recipient,
        amount: entry.guarantee.amount,
        coverage: asBigint(entry.guarantee.coverage),
        deadline: asBigint(entry.guarantee.deadline),
        status: asStatus(entry.guarantee.status),
        proofTxHash: entry.guarantee.proof_tx_hash,
      })),
    };
  } catch {
    // The deployed contract may predate get_guarantees. Fall through to per-id reads.
  }

  const rawRows = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      view<{
        agent: string;
        destination_chain: string;
        recipient: string;
        amount: string;
        coverage: string;
        deadline: string;
        status: unknown;
        proof_tx_hash: string | null;
      } | null>("get_guarantee", { guarantee_id: index + 1 }),
    ),
  );
  const guarantees: GuaranteeView[] = rawRows.flatMap((raw, index) => {
    if (raw == null) {
      return [];
    }
    return [{
      id: index + 1,
      agent: raw.agent,
      destinationChain: raw.destination_chain,
      recipient: raw.recipient,
      amount: raw.amount,
      coverage: asBigint(raw.coverage),
      deadline: asBigint(raw.deadline),
      status: asStatus(raw.status),
      proofTxHash: raw.proof_tx_hash,
    }];
  });

  return {
    config: {
      owner: configRaw.owner,
      checker: configRaw.checker,
      premium: asBigint(configRaw.premium),
    },
    pool: {
      poolBalance: asBigint(poolRaw.pool_balance),
      outstandingCoverage: asBigint(poolRaw.outstanding_coverage),
      freeCoverage: asBigint(poolRaw.free_coverage),
      premium: asBigint(poolRaw.premium),
    },
    guarantees,
  };
}
