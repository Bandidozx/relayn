/**
 * Wallet-layer tests: EIP-6963 discovery, chain handling and the exact bytes the payment sends.
 *
 * Everything here runs against scripted EIP-1193 providers and a fake `window` — no browser, no
 * extension, no network, no chain. That is possible because the wallet layer is a set of functions
 * over plain values, and it is worth insisting on: the assertions that matter are about *bytes*
 * (selector, recipient, amount, `value: "0x0"`) and about *what is not called* (no send on the
 * wrong chain, no submit after a rejected prompt), and both are invisible to a click-through test.
 *
 * The security claim these tests protect is narrow and absolute: the wallet path produces a
 * transaction hash and nothing else. It cannot activate a plan, and the outcome type it returns
 * has no field in which a plan, an amount or a status could travel.
 */
import { describe, expect, it, vi } from "vitest";
import {
  browserWalletWindow,
  buildTransferTransaction,
  classifyWalletError,
  decodeUint256,
  discoverInjectedWallets,
  EIP6963_ANNOUNCE_EVENT,
  EIP6963_REQUEST_EVENT,
  ERC20_BALANCE_OF_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  encodeErc20BalanceOf,
  encodeErc20Transfer,
  formatWalletBalance,
  hasSufficientBalance,
  insufficientBalanceMessage,
  KNOWN_EVM_CHAINS,
  legacyInjectedWallets,
  legacyWalletName,
  parseChainId,
  payWithWallet,
  readChainId,
  readTokenBalance,
  requestAccounts,
  sendTransfer,
  shortenAddress,
  switchToChain,
  toHexQuantity,
  WALLET_MESSAGES,
  WalletEncodeError,
  wrongNetworkMessage,
  type Eip1193Provider,
  type Eip6963ProviderDetail,
  type WalletPaymentTarget,
  type WalletWindow,
} from "@/lib/payments/crypto/wallet";
import { normalizeTxHash } from "@/lib/payments/crypto/amount";

/** The live configuration: Base mainnet, native Circle USDC, the operator's receiving address. */
const TARGET: WalletPaymentTarget = {
  chainId: 8453,
  networkLabel: "Base",
  asset: "USDC",
  assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  assetDecimals: 6,
  address: "0x9578031Bedb9cc7CE2d605Dbce2aecf2e63A4C88",
  amountBaseUnits: "100000",
};

const PAYER = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}`;

interface Call {
  method: string;
  params?: readonly unknown[] | object;
}

type Handlers = Record<string, (params: readonly unknown[]) => unknown>;

/** An EIP-1193 provider that answers by method name and records every call it received. */
function scriptedProvider(handlers: Handlers, flags: Partial<Eip1193Provider> = {}) {
  const calls: Call[] = [];
  const provider: Eip1193Provider & { calls: Call[] } = {
    ...flags,
    calls,
    async request({ method, params }) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) {
        throw Object.assign(new Error(`no handler for ${method}`), { code: -32601 });
      }
      return handler((params ?? []) as readonly unknown[]);
    },
  };
  return provider;
}

/** A provider that pays without complaint. */
function payingProvider(overrides: Handlers = {}) {
  return scriptedProvider({
    eth_chainId: () => "0x2105",
    eth_sendTransaction: () => HASH,
    ...overrides,
  });
}

/** A `window` that announces the given EIP-6963 details when asked, and nothing more. */
function fakeWindow(options: {
  announce?: Eip6963ProviderDetail[];
  ethereum?: Eip1193Provider;
} = {}): WalletWindow & { listenerCount: () => number } {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    ethereum: options.ethereum,
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      if (event.type !== EIP6963_REQUEST_EVENT) return true;
      for (const detail of options.announce ?? []) {
        const announcement = new CustomEvent(EIP6963_ANNOUNCE_EVENT, { detail });
        listeners.get(EIP6963_ANNOUNCE_EVENT)?.forEach((listener) => listener(announcement));
      }
      return true;
    },
  };
}

function detail(rdns: string, name: string, icon = "data:image/png;base64,aa"): Eip6963ProviderDetail {
  return {
    info: { uuid: `uuid-${rdns}`, name, icon, rdns },
    provider: scriptedProvider({ eth_chainId: () => "0x2105" }),
  };
}

/** 32-byte ABI word, as it appears in calldata. */
function wordAt(data: string, index: number): string {
  const body = data.slice(10);
  return body.slice(index * 64, (index + 1) * 64);
}

describe("Base chain detection (item 1)", () => {
  it("reads a hex chain id, a decimal string and a number alike", () => {
    expect(parseChainId("0x2105")).toBe(8453);
    expect(parseChainId("8453")).toBe(8453);
    expect(parseChainId(8453)).toBe(8453);
    expect(parseChainId(8453n)).toBe(8453);
  });

  it("refuses to guess at anything unreadable", () => {
    // A chain id that cannot be read must block payment, not default to "probably Base".
    for (const value of ["", "0x", "base", "0xzz", null, undefined, {}, -1, 0, 1.5]) {
      expect(parseChainId(value)).toBeNull();
    }
  });

  it("encodes 8453 as the minimal hex quantity wallets expect", () => {
    expect(toHexQuantity(8453)).toBe("0x2105");
    expect(KNOWN_EVM_CHAINS[8453]?.chainId).toBe("0x2105");
    expect(KNOWN_EVM_CHAINS[8453]?.chainName).toBe("Base");
    expect(KNOWN_EVM_CHAINS[84532]?.chainId).toBe("0x14a34");
  });

  it("hands the wallet no server-side RPC URL", () => {
    // CRYPTO_PAYMENT_RPC_URL may carry an API key. Only public endpoints are offered to a wallet.
    expect(KNOWN_EVM_CHAINS[8453]?.rpcUrls).toEqual(["https://mainnet.base.org"]);
  });

  it("reports the chain the provider is on", async () => {
    await expect(readChainId(payingProvider())).resolves.toBe(8453);
    await expect(readChainId(payingProvider({ eth_chainId: () => "0x1" }))).resolves.toBe(1);
  });
});

describe("wrong chain rejection (item 2)", () => {
  it("sends nothing at all when the wallet is on another chain", async () => {
    const provider = payingProvider({ eth_chainId: () => "0x1" });
    const submit = vi.fn(async () => {});

    const outcome = await payWithWallet({ provider, account: PAYER, target: TARGET, submit });

    expect(outcome).toEqual({
      status: "wrong_network",
      txHash: null,
      message: "Please switch to Base.",
    });
    // The important assertion is the absence: no transaction was broadcast on Ethereum mainnet.
    expect(provider.calls.map((call) => call.method)).toEqual(["eth_chainId"]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("blocks payment when the chain id cannot be read", async () => {
    const provider = payingProvider({ eth_chainId: () => "not-a-chain" });
    const submit = vi.fn(async () => {});

    const outcome = await payWithWallet({ provider, account: PAYER, target: TARGET, submit });

    expect(outcome.status).toBe("wrong_network");
    expect(submit).not.toHaveBeenCalled();
    expect(provider.calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  it("never switches network on its own", async () => {
    const provider = payingProvider({ eth_chainId: () => "0x1" });
    await payWithWallet({ provider, account: PAYER, target: TARGET, submit: async () => {} });
    // Switching is a separate, user-initiated call. Paying must not silently re-network a wallet.
    expect(provider.calls.some((call) => call.method === "wallet_switchEthereumChain")).toBe(false);
    expect(provider.calls.some((call) => call.method === "wallet_addEthereumChain")).toBe(false);
  });

  it("switches only when asked, and offers to add Base when the wallet does not know it", async () => {
    const known = scriptedProvider({ wallet_switchEthereumChain: () => null });
    await switchToChain(known, 8453);
    expect(known.calls).toEqual([
      { method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] },
    ]);

    let added = false;
    const unknown = scriptedProvider({
      wallet_switchEthereumChain: () => {
        if (!added) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
        return null;
      },
      wallet_addEthereumChain: () => {
        added = true;
        return null;
      },
    });
    await switchToChain(unknown, 8453);
    expect(unknown.calls.map((call) => call.method)).toEqual([
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
    expect(unknown.calls[1]?.params).toEqual([KNOWN_EVM_CHAINS[8453]]);
  });
});

describe("the transaction itself (items 3, 4, 5)", () => {
  it("calls the configured USDC contract, not the receiving address", async () => {
    const provider = payingProvider();
    await payWithWallet({ provider, account: PAYER, target: TARGET, submit: async () => {} });

    const sent = provider.calls.find((call) => call.method === "eth_sendTransaction");
    const params = (sent?.params as [{ to: string; from: string; value: string; data: string }])[0];
    expect(params.to).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(params.from).toBe(PAYER);
    // A native ETH transfer would be unverifiable — the backend matches ERC-20 Transfer events.
    expect(params.value).toBe("0x0");
    expect(params.data.slice(0, 10)).toBe(ERC20_TRANSFER_SELECTOR);
  });

  it("encodes the recipient from server configuration", () => {
    const data = encodeErc20Transfer(TARGET.address, TARGET.amountBaseUnits);
    expect(wordAt(data, 0)).toBe(`${"0".repeat(24)}9578031bedb9cc7ce2d605dbce2aecf2e63a4c88`);
  });

  it("encodes exactly 100000 base units", () => {
    const data = encodeErc20Transfer(TARGET.address, "100000");
    // 100000 = 0x186a0. Right-aligned in a 32-byte word, no floating point anywhere in the path.
    expect(wordAt(data, 1)).toBe(`${"0".repeat(59)}186a0`);
    expect(decodeUint256(`0x${wordAt(data, 1)}`)).toBe(100000n);
    expect(data).toHaveLength(2 + 8 + 128);
  });

  it("is byte-identical to the full calldata a reviewer can check by eye", () => {
    expect(buildTransferTransaction(PAYER, TARGET).data).toBe(
      "0xa9059cbb" +
        "0000000000000000000000009578031bedb9cc7ce2d605dbce2aecf2e63a4c88" +
        "00000000000000000000000000000000000000000000000000000000000186a0",
    );
  });

  it("refuses to encode anything that is not an address or a positive integer", () => {
    expect(() => encodeErc20Transfer("0xnope", "100000")).toThrow(WalletEncodeError);
    expect(() => encodeErc20Transfer(TARGET.address, "0")).toThrow(WalletEncodeError);
    expect(() => encodeErc20Transfer(TARGET.address, "0.1")).toThrow();
    expect(() => encodeErc20Transfer(TARGET.address, "100000.00000000001")).toThrow();
    expect(() => buildTransferTransaction("0x1234", TARGET)).toThrow(WalletEncodeError);
  });

  it("reads the payer's balance with balanceOf and compares it exactly", async () => {
    const provider = scriptedProvider({
      eth_call: () => `0x${(1_500_000n).toString(16).padStart(64, "0")}`,
    });
    await expect(readTokenBalance(provider, { token: TARGET.assetAddress, owner: PAYER })).resolves
      .toBe(1_500_000n);
    const call = provider.calls[0]?.params as [{ to: string; data: string }, string];
    expect(call[0].data).toBe(encodeErc20BalanceOf(PAYER));
    expect(call[0].data.slice(0, 10)).toBe(ERC20_BALANCE_OF_SELECTOR);
    expect(call[1]).toBe("latest");

    expect(hasSufficientBalance(100_000n, "100000")).toBe(true);
    expect(hasSufficientBalance(99_999n, "100000")).toBe(false);
    expect(formatWalletBalance(1_500_000n, 6)).toBe("1.50");
    expect(decodeUint256("0x")).toBe(0n);
  });
});

describe("wallet rejection (item 6)", () => {
  it("treats a rejected prompt as a cancellation and submits nothing", async () => {
    const provider = payingProvider({
      eth_sendTransaction: () => {
        throw Object.assign(new Error("MetaMask Tx Signature: User denied transaction signature."), {
          code: 4001,
        });
      },
    });
    const submit = vi.fn(async () => {});

    const outcome = await payWithWallet({ provider, account: PAYER, target: TARGET, submit });

    expect(outcome).toEqual({ status: "cancelled", txHash: null, message: "Payment cancelled." });
    expect(submit).not.toHaveBeenCalled();
  });

  it("reads the rejection code out of the shapes wallets actually use", () => {
    const context = { networkLabel: "Base", asset: "USDC" };
    const shapes: unknown[] = [
      { code: 4001 },
      { code: "4001" },
      { data: { originalError: { code: 4001 } } },
      { cause: { code: 4001 } },
      new Error("User rejected the request"),
      "user denied message signature",
    ];
    for (const shape of shapes) {
      expect(classifyWalletError(shape, context)).toEqual({
        kind: "cancelled",
        message: WALLET_MESSAGES.cancelled,
      });
    }
  });

  it("maps the remaining failures onto fixed copy and leaks no internals", () => {
    const context = { networkLabel: "Base", asset: "USDC" };
    expect(classifyWalletError(new Error("insufficient funds for gas"), context)).toEqual({
      kind: "insufficient",
      message: "Insufficient USDC balance.",
    });
    expect(classifyWalletError({ code: 4902 }, context).message).toBe("Please switch to Base.");
    expect(classifyWalletError({ code: 4900 }, context).message).toBe(WALLET_MESSAGES.unavailable);

    const leaky = new Error("fetch failed: connect ECONNREFUSED 10.0.0.1:8545 (https://node.local)");
    const classified = classifyWalletError(leaky, context);
    expect(classified.message).toBe(WALLET_MESSAGES.failed);
    expect(classified.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.1|http|node\.local/);
    expect(Object.values(WALLET_MESSAGES).some((m) => /rpc|http|json/i.test(m))).toBe(false);
  });

  it("survives a circular error object without hanging", () => {
    const circular: { code?: number; cause?: unknown } = {};
    circular.cause = circular;
    expect(classifyWalletError(circular, { networkLabel: "Base", asset: "USDC" }).kind).toBe(
      "failed",
    );
  });
});

describe("wallet discovery (items 7, 8, 9, 10, 11, 12)", () => {
  it("finds nothing when no wallet is installed (item 7)", async () => {
    const win = fakeWindow();
    await expect(discoverInjectedWallets(win, { timeoutMs: 0 })).resolves.toEqual([]);
    expect(WALLET_MESSAGES.unavailable).toBe("No compatible wallet detected.");
  });

  it("returns null for a window that does not exist", () => {
    // Server rendering: no window, no wallet, no crash.
    expect(browserWalletWindow()).toBeNull();
  });

  it("lists every announced wallet rather than picking one (items 8, 12)", async () => {
    const win = fakeWindow({
      announce: [
        detail("io.metamask", "MetaMask"),
        detail("io.rabby", "Rabby"),
        detail("com.okex.wallet", "OKX Wallet"),
      ],
    });
    const found = await discoverInjectedWallets(win, { timeoutMs: 0 });
    expect(found.map((wallet) => wallet.name)).toEqual(["MetaMask", "Rabby", "OKX Wallet"]);
    expect(found.map((wallet) => wallet.rdns)).toEqual([
      "io.metamask",
      "io.rabby",
      "com.okex.wallet",
    ]);
    expect(found.every((wallet) => wallet.source === "eip6963")).toBe(true);
    // Each wallet keeps its own provider, so the picker's choice actually decides who pays.
    expect(new Set(found.map((wallet) => wallet.provider)).size).toBe(3);
  });

  it("names known wallets consistently and keeps unknown ones as announced", async () => {
    const win = fakeWindow({
      announce: [detail("io.metamask", "MetaMask Wallet"), detail("xyz.newcomer", "Newcomer")],
    });
    const found = await discoverInjectedWallets(win, { timeoutMs: 0 });
    expect(found[0]?.name).toBe("MetaMask");
    expect(found[1]?.name).toBe("Newcomer");
  });

  it("deduplicates re-announcements and ignores malformed ones", async () => {
    const listeners: ((event: Event) => void)[] = [];
    const win: WalletWindow = {
      addEventListener: (_type, listener) => listeners.push(listener),
      removeEventListener: () => {},
      dispatchEvent: () => {
        const good = detail("io.rabby", "Rabby");
        for (const listener of listeners) {
          listener(new CustomEvent(EIP6963_ANNOUNCE_EVENT, { detail: good }));
          listener(new CustomEvent(EIP6963_ANNOUNCE_EVENT, { detail: good }));
          listener(new CustomEvent(EIP6963_ANNOUNCE_EVENT, { detail: { info: {} } }));
          listener(new CustomEvent(EIP6963_ANNOUNCE_EVENT, { detail: null }));
        }
        return true;
      },
    };
    const found = await discoverInjectedWallets(win, { timeoutMs: 0 });
    expect(found).toHaveLength(1);
    expect(found[0]?.rdns).toBe("io.rabby");
  });

  it("stops listening once the scan is over", async () => {
    const win = fakeWindow({ announce: [detail("io.metamask", "MetaMask")] });
    await discoverInjectedWallets(win, { timeoutMs: 0 });
    expect(win.listenerCount()).toBe(0);
  });
});

describe("legacy injected wallets (items 8, 9, 10, 11)", () => {
  it("labels MetaMask, Rabby and OKX from their own flags", () => {
    expect(legacyWalletName({ request: async () => null, isMetaMask: true })).toBe("MetaMask");
    // Rabby and OKX both claim isMetaMask for compatibility; the specific flag has to win.
    expect(legacyWalletName({ request: async () => null, isMetaMask: true, isRabby: true })).toBe(
      "Rabby",
    );
    expect(
      legacyWalletName({ request: async () => null, isMetaMask: true, isOkxWallet: true }),
    ).toBe("OKX Wallet");
    expect(legacyWalletName({ request: async () => null, isOKExWallet: true })).toBe("OKX Wallet");
    expect(legacyWalletName({ request: async () => null })).toBe("Injected wallet");
  });

  it("surfaces all of window.ethereum.providers instead of taking the first", () => {
    const metamask = scriptedProvider({}, { isMetaMask: true });
    const rabby = scriptedProvider({}, { isMetaMask: true, isRabby: true });
    const okx = scriptedProvider({}, { isOkxWallet: true });
    const root = scriptedProvider({}, { isMetaMask: true, providers: [metamask, rabby, okx] });

    const found = legacyInjectedWallets({
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      ethereum: root,
    });

    expect(found.map((wallet) => wallet.name)).toEqual(["MetaMask", "Rabby", "OKX Wallet"]);
    expect(found.map((wallet) => wallet.provider)).toEqual([metamask, rabby, okx]);
    expect(found.every((wallet) => wallet.source === "legacy")).toBe(true);
  });

  it("falls back to a lone window.ethereum, and only when nothing announced", async () => {
    const legacy = scriptedProvider({}, { isMetaMask: true });
    const onlyLegacy = await discoverInjectedWallets(fakeWindow({ ethereum: legacy }), {
      timeoutMs: 0,
    });
    expect(onlyLegacy).toHaveLength(1);
    expect(onlyLegacy[0]?.name).toBe("MetaMask");
    expect(onlyLegacy[0]?.source).toBe("legacy");

    // A wallet that does both must not appear twice under two different names.
    const both = await discoverInjectedWallets(
      fakeWindow({ ethereum: legacy, announce: [detail("io.metamask", "MetaMask")] }),
      { timeoutMs: 0 },
    );
    expect(both).toHaveLength(1);
    expect(both[0]?.source).toBe("eip6963");
  });

  it("skips entries that are not usable providers", () => {
    const broken = { isMetaMask: true } as unknown as Eip1193Provider;
    const found = legacyInjectedWallets({
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      ethereum: broken,
    });
    expect(found).toEqual([]);
  });
});

describe("the hash is the only thing that crosses the boundary (items 13, 14, 15)", () => {
  it("hands the backend exactly the hash the wallet reported (item 13)", async () => {
    const provider = payingProvider({ eth_sendTransaction: () => HASH.toUpperCase() });
    const submitted: string[] = [];

    const outcome = await payWithWallet({
      provider,
      account: PAYER,
      target: TARGET,
      submit: async (hash) => void submitted.push(hash),
    });

    // Lowercased by the same normaliser the server uses, which is what makes the UNIQUE index
    // on payments.txHash an actual double-spend defence.
    expect(submitted).toEqual([HASH]);
    expect(outcome.txHash).toBe(HASH);
    expect(normalizeTxHash(HASH.toUpperCase())).toBe(HASH);
  });

  it("refuses whatever a wallet returns that is not a transaction hash", async () => {
    for (const junk of [true, null, "0xdeadbeef", { hash: HASH }, ""]) {
      const provider = payingProvider({ eth_sendTransaction: () => junk });
      const submit = vi.fn(async () => {});
      const outcome = await payWithWallet({ provider, account: PAYER, target: TARGET, submit });
      expect(outcome.status).toBe("failed");
      expect(submit).not.toHaveBeenCalled();
    }
    await expect(
      sendTransfer(payingProvider({ eth_sendTransaction: () => "nope" }), {
        from: PAYER,
        to: TARGET.assetAddress,
        data: "0x",
        value: "0x0",
      }),
    ).rejects.toThrow(WalletEncodeError);
  });

  it("has nowhere to put an activation (items 14, 15)", async () => {
    const outcome = await payWithWallet({
      provider: payingProvider(),
      account: PAYER,
      target: TARGET,
      submit: async () => {},
    });

    // "submitted" means broadcast. Not verified, not paid, not activated — and the shape has no
    // field for a plan, an amount, a recipient or a status the server did not produce.
    expect(outcome.status).toBe("submitted");
    expect(Object.keys(outcome).sort()).toEqual(["message", "status", "txHash"]);
    expect(JSON.stringify(outcome)).not.toMatch(/unlimited|plan|activated|paid|amount/i);
  });

  it("reports a failure when the backend call throws, without inventing success", async () => {
    const outcome = await payWithWallet({
      provider: payingProvider(),
      account: PAYER,
      target: TARGET,
      submit: async () => {
        throw new Error("500 Internal Server Error at https://relayn.internal/api");
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toBe(WALLET_MESSAGES.failed);
    expect(WALLET_MESSAGES.verifyFailed).toBe("Payment could not be verified.");
  });
});

describe("connecting an account", () => {
  it("prompts for accounts and lowercases the one it uses", async () => {
    const provider = scriptedProvider({
      eth_requestAccounts: () => ["0xAbCdEf0123456789AbCdEf0123456789AbCdEf01"],
    });
    await expect(requestAccounts(provider)).resolves.toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
    expect(provider.calls).toEqual([{ method: "eth_requestAccounts", params: undefined }]);
  });

  it("refuses an empty or malformed account list", async () => {
    for (const answer of [[], [""], ["0x123"], null, "0xabc"]) {
      const provider = scriptedProvider({ eth_requestAccounts: () => answer });
      await expect(requestAccounts(provider)).rejects.toThrow(WalletEncodeError);
    }
  });

  it("never asks a wallet for anything that could expose a key", async () => {
    // The whole method surface this rail uses. No signing of arbitrary payloads, no key export,
    // no seed phrase, no custody: eth_accounts, chain read, a balance read and one transfer.
    const provider = payingProvider({ eth_requestAccounts: () => [PAYER] });
    await requestAccounts(provider);
    await readChainId(provider);
    await payWithWallet({ provider, account: PAYER, target: TARGET, submit: async () => {} });
    expect(provider.calls.map((call) => call.method)).toEqual([
      "eth_requestAccounts",
      "eth_chainId",
      "eth_chainId",
      "eth_sendTransaction",
    ]);
  });
});

describe("manual TX hash fallback (item 16)", () => {
  it("still accepts the hash forms a payer can paste", () => {
    const bare = "ab".repeat(32);
    expect(normalizeTxHash(`0x${bare}`)).toBe(`0x${bare}`);
    expect(normalizeTxHash(bare)).toBe(`0x${bare}`);
    expect(normalizeTxHash(`  0x${bare.toUpperCase()}  `)).toBe(`0x${bare}`);
    expect(normalizeTxHash("0xdeadbeef")).toBeNull();
    expect(normalizeTxHash(null)).toBeNull();
  });

  it("shares one normaliser with the wallet path, so both reach the same UNIQUE index", async () => {
    const provider = payingProvider({ eth_sendTransaction: () => HASH.toUpperCase() });
    let fromWallet: string | null = null;
    await payWithWallet({
      provider,
      account: PAYER,
      target: TARGET,
      submit: async (hash) => {
        fromWallet = hash;
      },
    });
    expect(fromWallet).toBe(normalizeTxHash(` ${HASH.toUpperCase()} `));
  });
});

describe("payer-facing copy", () => {
  it("uses the exact strings the specification asks for", () => {
    expect(WALLET_MESSAGES.cancelled).toBe("Payment cancelled.");
    expect(wrongNetworkMessage("Base")).toBe("Please switch to Base.");
    expect(insufficientBalanceMessage("USDC")).toBe("Insufficient USDC balance.");
    expect(WALLET_MESSAGES.unavailable).toBe("No compatible wallet detected.");
    expect(WALLET_MESSAGES.verifyFailed).toBe("Payment could not be verified.");
  });

  it("shortens the receiving and payer addresses the way the design shows", () => {
    expect(shortenAddress(TARGET.address)).toBe("0x9578...4C88");
    expect(shortenAddress("not-an-address")).toBe("not-an-address");
  });
});











