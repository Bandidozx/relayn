/**
 * The EVM/ERC-20 adapter: what the node said, and nothing else.
 *
 * Every fact this adapter reports is derived from four JSON-RPC results, so the tests drive it
 * through a mocked `fetch` that answers by method name. Three properties are being protected:
 *
 *   - **token amounts come from receipt logs, never from the transaction.** For an ERC-20
 *     transfer `tx.to` is the token contract and `tx.value` is zero, so an adapter that read
 *     those fields would see every payment as "0 to the wrong address".
 *   - **an unreachable node is not a verdict.** Transport, HTTP and JSON-RPC failures raise
 *     `CryptoProviderError`; only a node that answers "no such hash" produces `found: false`.
 *   - **`evmConfigFromEnv()` returns null rather than a half-configured gate.** A bad address,
 *     an unknown chain, a missing token or a malformed price must all disable the rail.
 *
 * The env-driven half re-imports the module under `vi.resetModules()` so it exercises the real
 * `src/lib/env.ts` wiring rather than a hand-built object.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTER_ID,
  EVM_NETWORKS,
  createEvmProvider,
  evmExpectation,
  type EvmConfig,
} from "@/lib/payments/crypto/evm";
import { CryptoProviderError } from "@/lib/payments/crypto/types";

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const FOREIGN_TOKEN = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const SENDER = "0x2222222222222222222222222222222222222222";
const OUTSIDER = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}`;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BLOCK = 20_000_000;
const HEAD = BLOCK + 5; // → 6 confirmations, inclusive of the transaction's own block
const MINED_SECONDS = 1_787_400_000;
const RPC_URL = "https://rpc.test.invalid";

function hex(value: number | bigint): string {
  return `0x${value.toString(16)}`;
}

function config(over: Partial<EvmConfig> = {}): EvmConfig {
  return {
    network: EVM_NETWORKS.base!,
    rpcUrl: RPC_URL,
    tokenAddress: TOKEN,
    assetSymbol: "USDC",
    assetDecimals: 6,
    recipient: RECIPIENT,
    requiredBaseUnits: "100000",
    amountDisplay: "0.10",
    minConfirmations: 3,
    maxAgeMs: 24 * 60 * 60 * 1000,
    explorerUrl: "https://basescan.org",
    ...over,
  };
}

/** A 20-byte address as a 32-byte indexed log topic. */
function topic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function transferLog(
  over: { token?: string; from?: string; to?: string; value?: bigint } = {},
): Record<string, unknown> {
  const { token = TOKEN, from = SENDER, to = RECIPIENT, value = 100_000n } = over;
  return {
    address: token,
    topics: [TRANSFER_TOPIC, topic(from), topic(to)],
    data: hex(value),
  };
}

/** The four answers a healthy node gives for a good payment. Any of them can be overridden. */
function node(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eth_chainId: hex(8453),
    eth_getTransactionByHash: {
      blockNumber: hex(BLOCK),
      chainId: hex(8453),
      from: SENDER,
      // An ERC-20 transfer is addressed to the token contract and carries no value.
      to: TOKEN,
      value: "0x0",
    },
    eth_getTransactionReceipt: { status: "0x1", blockNumber: hex(BLOCK), logs: [transferLog()] },
    eth_blockNumber: hex(HEAD),
    eth_getBlockByNumber: { timestamp: hex(MINED_SECONDS) },
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Installs a `fetch` that answers JSON-RPC by method name. A handler may be a plain result, a
 * function of the params, a `Response` (for HTTP-level failures) or a thrower (for transport
 * failures). An unexpected method fails the test rather than returning undefined.
 */
function mockRpc(handlers: Record<string, unknown>): { methods: string[] } {
  const methods: string[] = [];
  const impl = async (_url: unknown, init?: unknown): Promise<Response> => {
    const raw = (init as { body?: string } | undefined)?.body ?? "{}";
    const call = JSON.parse(raw) as { id?: number; method: string; params: unknown[] };
    methods.push(call.method);
    if (!(call.method in handlers)) {
      throw new Error(`unexpected RPC method: ${call.method}`);
    }
    const handler = handlers[call.method];
    const value =
      typeof handler === "function" ? (handler as (p: unknown[]) => unknown)(call.params) : handler;
    if (value instanceof Response) return value;
    return jsonResponse({ jsonrpc: "2.0", id: call.id ?? 1, result: value });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((...args: unknown[]) => impl(args[0], args[1])),
  );
  return { methods };
}

async function observe(handlers: Record<string, unknown>, over: Partial<EvmConfig> = {}) {
  mockRpc(handlers);
  return createEvmProvider(config(over)).verifyTransaction(HASH);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyTransaction — a good payment", () => {
  it("reads the amount from the Transfer logs, not from the transaction fields", async () => {
    const observed = await observe(node());
    expect(observed).toEqual({
      txHash: HASH,
      found: true,
      chainId: 8453,
      txChainId: 8453,
      mined: true,
      succeeded: true,
      blockNumber: String(BLOCK),
      confirmations: 6,
      minedAt: new Date(MINED_SECONDS * 1000),
      receivedBaseUnits: "100000",
      sender: SENDER,
      assetMovedElsewhere: false,
      otherAssetReceived: false,
    });
  });

  it("sums several transfers of our asset to our address in one transaction", async () => {
    const observed = await observe(
      node({
        eth_getTransactionReceipt: {
          status: "0x1",
          logs: [
            transferLog({ value: 60_000n }),
            transferLog({ value: 40_000n, from: OUTSIDER }),
          ],
        },
      }),
    );
    expect(observed.receivedBaseUnits).toBe("100000");
    // The payer of record is the first matching transfer, not the last.
    expect(observed.sender).toBe(SENDER);
  });

  it("matches a checksummed contract and checksummed topics case-insensitively", async () => {
    const observed = await observe(
      node({
        eth_getTransactionReceipt: {
          status: "0x1",
          logs: [
            {
              address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              topics: [
                TRANSFER_TOPIC.toUpperCase().replace("0X", "0x"),
                topic(SENDER).toUpperCase().replace("0X", "0x"),
                topic(RECIPIENT).toUpperCase().replace("0X", "0x"),
              ],
              data: hex(100_000n),
            },
          ],
        },
      }),
    );
    expect(observed.receivedBaseUnits).toBe("100000");
    expect(observed.sender).toBe(SENDER);
  });
});

describe("verifyTransaction — what went wrong, told apart", () => {
  it("distinguishes our asset moving elsewhere from nothing arriving", async () => {
    const observed = await observe(
      node({
        eth_getTransactionReceipt: {
          status: "0x1",
          logs: [transferLog({ to: OUTSIDER })],
        },
      }),
    );
    expect(observed.receivedBaseUnits).toBe("0");
    expect(observed.assetMovedElsewhere).toBe(true);
    expect(observed.otherAssetReceived).toBe(false);
    // No matching transfer, so the payer falls back to the transaction's own sender.
    expect(observed.sender).toBe(SENDER);
  });

  it("flags a different token reaching our address as the wrong asset", async () => {
    const observed = await observe(
      node({
        eth_getTransactionReceipt: {
          status: "0x1",
          logs: [transferLog({ token: FOREIGN_TOKEN, value: 5_000_000n })],
        },
      }),
    );
    expect(observed.receivedBaseUnits).toBe("0");
    expect(observed.otherAssetReceived).toBe(true);
    expect(observed.assetMovedElsewhere).toBe(false);
  });

  it("flags a plain native-coin send to our address as the wrong asset", async () => {
    // No logs at all: ETH was sent straight to the receiving address. Money arrived, so the
    // payer gets the wrong-asset message rather than the wrong-address one.
    const observed = await observe(
      node({
        eth_getTransactionByHash: {
          blockNumber: hex(BLOCK),
          chainId: hex(8453),
          from: SENDER,
          to: RECIPIENT.toUpperCase().replace("0X", "0x"),
          value: hex(10n ** 15n),
        },
        eth_getTransactionReceipt: { status: "0x1", logs: [] },
      }),
    );
    expect(observed.receivedBaseUnits).toBe("0");
    expect(observed.otherAssetReceived).toBe(true);
  });

  it("ignores logs that are not a standard three-topic Transfer", async () => {
    const observed = await observe(
      node({
        eth_getTransactionReceipt: {
          status: "0x1",
          logs: [
            // An Approval, or any other event, on our token.
            { address: TOKEN, topics: [`0x${"1".repeat(64)}`, topic(SENDER), topic(RECIPIENT)], data: hex(100_000n) },
            // A Transfer that does not index its recipient: unreadable, so not counted.
            { address: TOKEN, topics: [TRANSFER_TOPIC], data: hex(100_000n) },
            // A malformed topic of the wrong width.
            { address: TOKEN, topics: [TRANSFER_TOPIC, topic(SENDER), "0x1234"], data: hex(100_000n) },
            // No topics at all.
            { address: TOKEN, data: hex(100_000n) },
          ],
        },
      }),
    );
    expect(observed.receivedBaseUnits).toBe("0");
    expect(observed.assetMovedElsewhere).toBe(false);
    expect(observed.otherAssetReceived).toBe(false);
  });

  it("reports a reverted transaction as mined but unsuccessful", async () => {
    const observed = await observe(
      node({ eth_getTransactionReceipt: { status: "0x0", logs: [] } }),
    );
    expect(observed.mined).toBe(true);
    expect(observed.succeeded).toBe(false);
  });
});

describe("verifyTransaction — existence, finality and short circuits", () => {
  it("stops at eth_chainId when the node serves the wrong chain", async () => {
    const calls = mockRpc({ eth_chainId: hex(1) });
    const observed = await createEvmProvider(config()).verifyTransaction(HASH);
    // Nothing the node says about a transaction on another chain is worth interpreting.
    expect(calls.methods).toEqual(["eth_chainId"]);
    expect(observed.chainId).toBe(1);
    expect(observed.found).toBe(false);
  });

  it("reports a hash the node has never seen as not-found, not as invalid", async () => {
    const observed = await observe(node({ eth_getTransactionByHash: null }));
    expect(observed.found).toBe(false);
    expect(observed.chainId).toBe(8453);
    expect(observed.mined).toBe(false);
    expect(observed.succeeded).toBeNull();
  });

  it("stops before the receipt for a transaction still in the mempool", async () => {
    const calls = mockRpc(
      node({
        eth_getTransactionByHash: { blockNumber: null, chainId: hex(8453), from: SENDER },
      }),
    );
    const observed = await createEvmProvider(config()).verifyTransaction(HASH);
    expect(calls.methods).toEqual(["eth_chainId", "eth_getTransactionByHash"]);
    expect(observed).toMatchObject({
      found: true,
      mined: false,
      succeeded: null,
      confirmations: 0,
      receivedBaseUnits: "0",
    });
  });

  it("treats a missing receipt on a mined transaction as not-yet-mined", async () => {
    // A real race on a node that has the transaction but not yet its receipt.
    const observed = await observe(node({ eth_getTransactionReceipt: null }));
    expect(observed).toMatchObject({ found: true, mined: false, succeeded: null });
  });

  it("counts confirmations inclusively and never negatively", async () => {
    expect((await observe(node({ eth_blockNumber: hex(BLOCK) }))).confirmations).toBe(1);
    expect((await observe(node({ eth_blockNumber: hex(BLOCK - 1) }))).confirmations).toBe(0);
    expect((await observe(node({ eth_blockNumber: hex(BLOCK + 99) }))).confirmations).toBe(100);
  });

  it("reads a transaction that predates typed chain ids as having none", async () => {
    const observed = await observe(
      node({
        eth_getTransactionByHash: { blockNumber: hex(BLOCK), from: SENDER, to: TOKEN, value: "0x0" },
      }),
    );
    expect(observed.txChainId).toBeNull();
  });

  it("evaluates the transfer without a timestamp when the block header cannot be read", async () => {
    // The age check is hardening, not a gate — a header read failure must not fail a payment.
    const observed = await observe(
      node({
        eth_getBlockByNumber: () => {
          throw new Error("header unavailable");
        },
      }),
    );
    expect(observed.minedAt).toBeNull();
    expect(observed.receivedBaseUnits).toBe("100000");
  });

  it("tolerates a block header with no usable timestamp", async () => {
    expect((await observe(node({ eth_getBlockByNumber: { timestamp: "0x0" } }))).minedAt).toBeNull();
    expect((await observe(node({ eth_getBlockByNumber: null }))).minedAt).toBeNull();
  });
});

describe("an unreachable node is an outage, not a verdict", () => {
  const provider = () => createEvmProvider(config());

  it("raises CryptoProviderError on a transport failure", async () => {
    mockRpc({
      eth_chainId: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(provider().verifyTransaction(HASH)).rejects.toBeInstanceOf(CryptoProviderError);
  });

  it("raises CryptoProviderError on an HTTP error status", async () => {
    mockRpc({ eth_chainId: new Response("rate limited", { status: 429 }) });
    await expect(provider().verifyTransaction(HASH)).rejects.toBeInstanceOf(CryptoProviderError);
  });

  it("raises CryptoProviderError on a JSON-RPC error object", async () => {
    mockRpc({
      ...node(),
      eth_getTransactionByHash: jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "invalid params" },
      }),
    });
    await expect(provider().verifyTransaction(HASH)).rejects.toBeInstanceOf(CryptoProviderError);
  });

  it("raises CryptoProviderError on a non-JSON body", async () => {
    mockRpc({ eth_chainId: new Response("<html>gateway</html>", { status: 200 }) });
    await expect(provider().verifyTransaction(HASH)).rejects.toBeInstanceOf(CryptoProviderError);
  });

  it("names the adapter but never the endpoint in the error it raises", async () => {
    mockRpc({
      eth_chainId: () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:8545");
      },
    });
    const error: CryptoProviderError = await provider()
      .verifyTransaction(HASH)
      .then(
        () => {
          throw new Error("verifyTransaction resolved instead of raising");
        },
        (e: unknown) => e as CryptoProviderError,
      );
    expect(error.providerId).toBe(ADAPTER_ID);
    // The node's own text is carried as `cause` for the server log, not in the message.
    expect(error.message).not.toContain(RPC_URL);
    expect(error.message).not.toContain("ECONNREFUSED");
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe("getPaymentInstructions", () => {
  it("publishes only values that are safe in a browser", () => {
    const instructions = createEvmProvider(config()).getPaymentInstructions();
    expect(instructions).toEqual({
      network: "base",
      networkLabel: "Base",
      chainId: 8453,
      asset: "USDC",
      assetAddress: TOKEN,
      assetDecimals: 6,
      address: RECIPIENT,
      amount: "0.10",
      amountBaseUnits: "100000",
      priceUsd: "0.10",
      minConfirmations: 3,
      explorerUrl: "https://basescan.org",
    });
    // There is no field for a key, because Relayn only ever reads the chain.
    expect(Object.keys(instructions)).not.toContain("privateKey");
  });

  it("names the four env vars an operator must set, and no secret among them", () => {
    expect(createEvmProvider(config()).credentialEnvVars).toEqual([
      "CRYPTO_PAYMENT_NETWORK",
      "CRYPTO_PAYMENT_ASSET",
      "CRYPTO_PAYMENT_ADDRESS",
      "CRYPTO_PAYMENT_AMOUNT",
    ]);
  });

  it("formats base units back to whole units for display and audit metadata", () => {
    const provider = createEvmProvider(config());
    expect(provider.normalizePayment("100000")).toBe("0.1");
    expect(provider.normalizePayment("0")).toBe("0");
    expect(provider.label).toBe("Base · USDC");
    expect(provider.isConfigured()).toBe(true);
  });

  it("derives the rules-layer expectation from configuration alone", () => {
    expect(evmExpectation(config())).toEqual({
      chainId: 8453,
      recipient: RECIPIENT,
      requiredBaseUnits: "100000",
      minConfirmations: 3,
      maxAgeMs: 86_400_000,
    });
  });
});

describe("evmConfigFromEnv", () => {
  const KEYS = [
    "CRYPTO_PAYMENT_NETWORK",
    "CRYPTO_PAYMENT_ASSET",
    "CRYPTO_PAYMENT_TOKEN_ADDRESS",
    "CRYPTO_PAYMENT_ASSET_DECIMALS",
    "CRYPTO_PAYMENT_ADDRESS",
    "CRYPTO_PAYMENT_AMOUNT",
    "CRYPTO_PAYMENT_RPC_URL",
    "CRYPTO_PAYMENT_MIN_CONFIRMATIONS",
    "CRYPTO_PAYMENT_MAX_AGE_HOURS",
    "CRYPTO_PAYMENT_EXPLORER_URL",
  ] as const;

  let snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  /** Re-imports the module so the real `src/lib/env.ts` re-reads `process.env`. */
  async function configFromEnv(vars: Record<string, string>): Promise<EvmConfig | null> {
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
    vi.resetModules();
    const mod = await import("@/lib/payments/crypto/evm");
    return mod.evmConfigFromEnv();
  }

  const MINIMAL = { CRYPTO_PAYMENT_NETWORK: "base", CRYPTO_PAYMENT_ADDRESS: RECIPIENT };

  it("builds a Base/USDC gate from two variables", async () => {
    const built = await configFromEnv(MINIMAL);
    expect(built).not.toBeNull();
    expect(built).toMatchObject({
      rpcUrl: "https://mainnet.base.org",
      // Defaulted to Circle's native USDC on Base, and lowercased.
      tokenAddress: TOKEN,
      assetSymbol: "USDC",
      assetDecimals: 6,
      recipient: RECIPIENT,
      // $0.10 as a fixed integer. No market rate is consulted anywhere in this path.
      requiredBaseUnits: "100000",
      amountDisplay: "0.10",
      minConfirmations: 3,
      maxAgeMs: 86_400_000,
      explorerUrl: "https://basescan.org",
    });
    expect(built?.network.chainId).toBe(8453);
  });

  it("normalises a checksummed receiving address and trims the network slug", async () => {
    const built = await configFromEnv({
      CRYPTO_PAYMENT_NETWORK: "  BASE  ",
      CRYPTO_PAYMENT_ADDRESS: RECIPIENT.toUpperCase().replace("0X", "0x"),
    });
    expect(built?.recipient).toBe(RECIPIENT);
  });

  it("honours every override, and strips a trailing slash from the explorer", async () => {
    const built = await configFromEnv({
      ...MINIMAL,
      CRYPTO_PAYMENT_ASSET: "USDbC",
      CRYPTO_PAYMENT_TOKEN_ADDRESS: FOREIGN_TOKEN.toUpperCase().replace("0X", "0x"),
      CRYPTO_PAYMENT_ASSET_DECIMALS: "18",
      CRYPTO_PAYMENT_AMOUNT: "0.5",
      CRYPTO_PAYMENT_RPC_URL: "https://node.example/rpc",
      CRYPTO_PAYMENT_MIN_CONFIRMATIONS: "12",
      CRYPTO_PAYMENT_MAX_AGE_HOURS: "2",
      CRYPTO_PAYMENT_EXPLORER_URL: "https://explorer.example/",
    });
    expect(built).toMatchObject({
      assetSymbol: "USDbC",
      tokenAddress: FOREIGN_TOKEN,
      assetDecimals: 18,
      requiredBaseUnits: "500000000000000000",
      minConfirmations: 12,
      maxAgeMs: 7_200_000,
      rpcUrl: "https://node.example/rpc",
      explorerUrl: "https://explorer.example",
    });
  });

  it("clamps negative confirmation and age settings to zero rather than inverting them", async () => {
    const built = await configFromEnv({
      ...MINIMAL,
      CRYPTO_PAYMENT_MIN_CONFIRMATIONS: "-5",
      CRYPTO_PAYMENT_MAX_AGE_HOURS: "-1",
    });
    expect(built?.minConfirmations).toBe(0);
    expect(built?.maxAgeMs).toBe(0);
  });

  it("returns null — not a half-configured gate — for every unusable configuration", async () => {
    const unusable: Array<[string, Record<string, string>]> = [
      ["nothing set at all", {}],
      ["an unknown network", { ...MINIMAL, CRYPTO_PAYMENT_NETWORK: "ethereum" }],
      ["a network typo", { ...MINIMAL, CRYPTO_PAYMENT_NETWORK: "bases" }],
      ["no receiving address", { CRYPTO_PAYMENT_NETWORK: "base" }],
      ["a truncated address", { ...MINIMAL, CRYPTO_PAYMENT_ADDRESS: "0x1111" }],
      ["a non-hex address", { ...MINIMAL, CRYPTO_PAYMENT_ADDRESS: `0x${"z".repeat(40)}` }],
      ["an address missing its prefix", { ...MINIMAL, CRYPTO_PAYMENT_ADDRESS: "1".repeat(40) }],
      ["a malformed token contract", { ...MINIMAL, CRYPTO_PAYMENT_TOKEN_ADDRESS: "0xnope" }],
      // Base Sepolia deliberately carries no default token: the operator must name it.
      ["a testnet with no token named", { ...MINIMAL, CRYPTO_PAYMENT_NETWORK: "base-sepolia" }],
      ["a price of zero", { ...MINIMAL, CRYPTO_PAYMENT_AMOUNT: "0" }],
      ["a negative price", { ...MINIMAL, CRYPTO_PAYMENT_AMOUNT: "-0.10" }],
      ["a non-numeric price", { ...MINIMAL, CRYPTO_PAYMENT_AMOUNT: "ten cents" }],
      ["a price in scientific notation", { ...MINIMAL, CRYPTO_PAYMENT_AMOUNT: "1e-1" }],
      // 0.1000005 USDC cannot be represented in 6 decimals; silently rounding an operator's
      // price into a live payment gate would be worse than disabling the rail.
      ["a price finer than the asset's decimals", { ...MINIMAL, CRYPTO_PAYMENT_AMOUNT: "0.1000005" }],
    ];

    for (const [label, vars] of unusable) {
      expect(await configFromEnv(vars), label).toBeNull();
      for (const key of KEYS) delete process.env[key];
    }
  });

  it("keeps the adapter absent while the rail is unconfigured", async () => {
    vi.resetModules();
    const mod = await import("@/lib/payments/crypto/evm");
    expect(mod.evmProviderFromEnv()).toBeNull();
  });

  it("returns a live adapter once the rail is configured", async () => {
    for (const [key, value] of Object.entries(MINIMAL)) process.env[key] = value;
    vi.resetModules();
    const mod = await import("@/lib/payments/crypto/evm");
    const provider = mod.evmProviderFromEnv();
    expect(provider?.id).toBe(ADAPTER_ID);
    expect(provider?.getPaymentInstructions().address).toBe(RECIPIENT);
  });
});
