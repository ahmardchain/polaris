import { useEffect, useState } from "react";
import { CONTRACT_ID, nearTx, recorded, sepoliaTx, type RecordedGuarantee } from "./demo-data.ts";
import { loadChain, type ConfigView, type GuaranteeView, type PoolView } from "./near.ts";
import { capAllows, nearToYocto, shownStatus, yoctoToNear, type ShownStatus } from "./status.ts";

const demoById = new Map(recorded.map((item) => [item.id, item]));

export function App() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [pool, setPool] = useState<PoolView | null>(null);
  const [guarantees, setGuarantees] = useState<GuaranteeView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string>("");

  async function refresh() {
    try {
      const chain = await loadChain();
      setConfig(chain.config);
      setPool(chain.pool);
      setGuarantees(chain.guarantees);
      setLoadedAt(new Date().toISOString());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main>
      <h1>Polaris guarantees</h1>
      <p className="meta">
        Contract <span className="mono">{CONTRACT_ID}</span>. Data is read from NEAR testnet.
        Recorded scenario A and B links are pinned below.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {config && pool ? <Stats config={config} pool={pool} loadedAt={loadedAt} /> : <p>Loading chain data.</p>}
      <h2>Recorded scenarios</h2>
      <div className="cards">
        {recorded.map((item) => (
          <DemoCard key={item.id} item={item} live={guarantees.find((row) => row.id === item.id)} />
        ))}
      </div>
      <h2>On-chain guarantees</h2>
      <GuaranteeTable rows={guarantees} />
      <h2>Optional Base USDC payout</h2>
      <QuotePanel />
      <h2>Buy a guarantee</h2>
      {config && pool ? <BuyForm config={config} pool={pool} /> : null}
    </main>
  );
}

function Stats(props: { config: ConfigView; pool: PoolView; loadedAt: string }) {
  const same = props.config.owner === props.config.checker;
  return (
    <section className="card">
      <div className="row">
        <span>Owner <span className="mono">{props.config.owner}</span></span>
        <span>Checker <span className="mono">{props.config.checker}</span></span>
      </div>
      <p className="meta">
        Premium {yoctoToNear(props.config.premium)} NEAR. Pool {yoctoToNear(props.pool.poolBalance)} NEAR.
        Outstanding {yoctoToNear(props.pool.outstandingCoverage)} NEAR.
        Free coverage {yoctoToNear(props.pool.freeCoverage)} NEAR.
        {same ? " Checker is the owner." : " Checker is not the owner."}
        {props.loadedAt ? ` Loaded ${props.loadedAt}.` : ""}
      </p>
    </section>
  );
}

function DemoCard(props: { item: RecordedGuarantee; live: GuaranteeView | undefined }) {
  const status: ShownStatus = props.live
    ? shownStatus({
        chainStatus: props.live.status,
        demo: {
          underpriced: props.item.underpricedTx,
          replacement: props.item.replacementTx ?? undefined,
        },
      })
    : "Pending";
  return (
    <article className="card">
      <div className="row">
        <strong>Scenario {props.item.scenario}</strong>
        <span>Guarantee {props.item.id}</span>
        <span className={`badge ${status}`}>{status}</span>
      </div>
      <p>{props.item.title}</p>
      <p className="meta">{props.item.note}</p>
      <ol className="timeline">
        <li><a href={nearTx(props.item.buyTx)}>Buy</a>. Pending {props.item.pendingMs} ms. Underpriced MPC {props.item.mpcUnderpricedMs} ms.</li>
        <li><a href={sepoliaTx(props.item.underpricedTx)}>Stuck underpriced transaction</a></li>
        <li className={props.item.replacementTx ? "" : "skipped"}>
          {props.item.replacementTx ? (
            <a href={sepoliaTx(props.item.replacementTx)}>Fee-bumped replacement</a>
          ) : (
            "No fee bump. The deadline would have passed first."
          )}
          {props.item.mpcReplacementMs !== null ? ` MPC ${props.item.mpcReplacementMs} ms.` : ""}
        </li>
        <li className={props.item.proofTx ? "" : "skipped"}>
          {props.item.proofTx ? <a href={nearTx(props.item.proofTx)}>submit_proof</a> : "No proof submitted."}
        </li>
        <li className={props.item.claimTx ? "" : "skipped"}>
          {props.item.claimTx ? <a href={nearTx(props.item.claimTx)}>claim</a> : "No claim. Delivery was proved."}
        </li>
        {props.item.nonceRecoveryTx ? (
          <li><a href={sepoliaTx(props.item.nonceRecoveryTx)}>Nonce recovery</a>. Not a proof.</li>
        ) : null}
      </ol>
    </article>
  );
}

function GuaranteeTable(props: { rows: GuaranteeView[] }) {
  if (props.rows.length === 0) {
    return <p>No guarantees returned.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Id</th>
          <th>Status</th>
          <th>Chain</th>
          <th>Recipient</th>
          <th>Amount</th>
          <th>Coverage</th>
          <th>Links</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => {
          const demo = demoById.get(row.id);
          const status = shownStatus({
            chainStatus: row.status,
            demo: demo
              ? { underpriced: demo.underpricedTx, replacement: demo.replacementTx ?? undefined }
              : undefined,
          });
          return (
            <tr key={row.id}>
              <td>{row.id}</td>
              <td><span className={`badge ${status}`}>{status}</span></td>
              <td>{row.destinationChain}</td>
              <td className="mono">{short(row.recipient)}</td>
              <td className="mono">{row.amount}</td>
              <td>{yoctoToNear(row.coverage)} NEAR</td>
              <td>
                {row.proofTxHash ? <a href={sepoliaTx(row.proofTxHash)}>Sepolia proof</a> : "No proof"}
                {demo ? (
                  <>
                    {" "}
                    <a href={nearTx(demo.buyTx)}>Buy</a>
                  </>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BuyForm(props: { config: ConfigView; pool: PoolView }) {
  const [chain, setChain] = useState("ethereum-sepolia");
  const [recipient, setRecipient] = useState("0x000000000000000000000000000000000000dEaD");
  const [amount, setAmount] = useState("1");
  const [coverageNear, setCoverageNear] = useState("0.0002");
  const [minutes, setMinutes] = useState("20");
  const [copied, setCopied] = useState(false);

  const coverage = nearToYocto(coverageNear);
  const allowed = coverage !== null && capAllows({
    poolBalance: props.pool.poolBalance,
    outstanding: props.pool.outstandingCoverage,
    premium: props.config.premium,
    coverage,
  });
  const deadlineMs = Date.now() + Number(minutes) * 60_000;
  const args = coverage === null || !Number.isFinite(Number(minutes))
    ? null
    : {
        destination_chain: chain,
        recipient,
        amount,
        coverage: coverage.toString(),
        deadline: (BigInt(Math.floor(deadlineMs)) * 1_000_000n).toString(),
      };

  const command = args
    ? `near contract call-function as-transaction ${CONTRACT_ID} buy_guarantee json-args '${JSON.stringify(args)}' prepaid-gas '80 Tgas' attached-deposit '${yoctoToNear(props.config.premium)} NEAR' sign-as YOUR_AGENT.testnet network-config testnet sign-with-keychain send`
    : "";

  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <div className="fields">
        <label>Destination chain
          <input value={chain} onChange={(event) => setChain(event.target.value)} />
        </label>
        <label>Recipient
          <input value={recipient} onChange={(event) => setRecipient(event.target.value)} />
        </label>
        <label>Amount (destination units)
          <input value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <label>Coverage (NEAR)
          <input value={coverageNear} onChange={(event) => setCoverageNear(event.target.value)} />
        </label>
        <label>Deadline (minutes from now)
          <input value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        </label>
      </div>
      <p className={allowed ? "ok" : "error"}>
        Attach exactly {yoctoToNear(props.config.premium)} NEAR.
        {coverage === null ? " Coverage is not a NEAR amount." : ""}
        {coverage !== null && allowed ? " Pool cap allows this coverage." : ""}
        {coverage !== null && !allowed ? " Pool cap refuses this coverage." : ""}
      </p>
      <div className="row">
        <button
          type="button"
          disabled={!command || !allowed}
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => setCopied(true));
          }}
        >
          Copy buy command
        </button>
        {copied ? <span className="meta">Copied.</span> : null}
      </div>
      {command ? <pre>{command}</pre> : null}
      <p className="meta">
        The page does not hold a NEAR key. Run the command with the agent account, or run <span className="mono">npm run demo</span> in <span className="mono">checker/</span>.
      </p>
    </form>
  );
}

function QuotePanel() {
  const [text, setText] = useState("Requesting a dry 1-Click quote.");

  useEffect(() => {
    const controller = new AbortController();
    void loadQuotes(controller.signal).then(setText).catch((error: unknown) => {
      setText(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, []);

  return (
    <section className="card">
      <p>
        A claim pays NEAR on testnet. NEAR Intents has no testnet, so this quote uses <span className="mono">dry: true</span>.
        No deposit address is requested and no swap is sent.
      </p>
      <pre>{text}</pre>
    </section>
  );
}

async function loadQuotes(signal: AbortSignal): Promise<string> {
  const claim = await postQuote({
    originAsset: "nep141:wrap.near",
    destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    amount: "200000000000000000000",
    recipient: "0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6",
    refundTo: "polaris-d1-z7npttup.testnet",
  }, signal);
  const lines = [`wNEAR to Base USDC for the 0.0002 NEAR claim: ${summarize(claim)}`];
  if (!claim.quote) {
    const example = await postQuote({
      originAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
      destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      amount: "1000000",
      recipient: "0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6",
      refundTo: "0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6",
    }, signal);
    lines.push(`1 ETH USDC to Base USDC, the dry route the API currently prices: ${summarize(example)}`);
  }
  lines.push("Mainnet tiny path: same request with dry:false, then send the quoted origin amount to depositAddress. Not run here.");
  return lines.join("\n");
}

async function postQuote(input: {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
}, signal: AbortSignal): Promise<{ message?: string; quote?: { amountOutFormatted?: string; amountOutUsd?: string; timeEstimate?: number; depositAddress?: string | null } }> {
  const response = await fetch("https://1click.chaindefuser.com/v0/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: input.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: input.destinationAsset,
      amount: input.amount,
      recipient: input.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: input.refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
  return response.json() as Promise<{ message?: string; quote?: { amountOutFormatted?: string; amountOutUsd?: string; timeEstimate?: number; depositAddress?: string | null } }>;
}

function summarize(body: { message?: string; quote?: { amountOutFormatted?: string; amountOutUsd?: string; timeEstimate?: number; depositAddress?: string | null } }): string {
  if (!body.quote) {
    return body.message ?? "no quote";
  }
  const deposit = body.quote.depositAddress ? body.quote.depositAddress : "none (dry)";
  return `${body.quote.amountOutFormatted} USDC, about $${body.quote.amountOutUsd}, eta ${body.quote.timeEstimate}s, deposit ${deposit}`;
}

function short(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
