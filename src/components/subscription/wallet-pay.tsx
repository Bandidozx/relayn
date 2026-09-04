"use client";

/**
 * "Connect Wallet" for the one-time Unlimited purchase.
 *
 * A convenience layer over the same verification that has always been there. The panel connects
 * to an injected wallet, checks it is on the required chain, builds one ERC-20 transfer and hands
 * the resulting transaction hash to `onTxHash` — which posts it to the existing verify endpoint.
 * The wallet's response is never treated as payment: nothing here sets a plan, and the only
 * "confirmed" state the page can reach is the one the server returned after reading the chain.
 *
 * Chain, token, recipient and amount all come from `target`, which is server-rendered public
 * configuration. None of them has a client-side default, so there is nothing here to tamper with
 * that the backend would not catch anyway.
 *
 * No wallet SDK, no WalletConnect project id, no analytics: discovery is EIP-6963 with a legacy
 * `window.ethereum` fallback, and every wallet found is spoken to over plain EIP-1193. Relayn
 * never asks for a private key or a seed phrase and never holds custody of anything.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  browserWalletWindow,
  classifyWalletError,
  discoverInjectedWallets,
  formatWalletBalance,
  hasSufficientBalance,
  insufficientBalanceMessage,
  KNOWN_EVM_CHAINS,
  payWithWallet,
  readChainId,
  readTokenBalance,
  requestAccounts,
  shortenAddress,
  switchToChain,
  WALLET_MESSAGES,
  wrongNetworkMessage,
  type DiscoveredWallet,
  type WalletPaymentTarget,
} from "@/lib/payments/crypto/wallet";

/** Where the payer is in the wallet half of the flow. The server half is `verifying`. */
type Stage = "idle" | "picking" | "connecting" | "ready" | "switching" | "waiting" | "submitted";

interface Connection {
  wallet: DiscoveredWallet;
  account: string;
}

/** Wallet-supplied icons are rendered, never fetched. EIP-6963 mandates a data URI; anything
 *  else — an `http:` tracker, a `javascript:` URI — is dropped rather than put in the DOM. */
function safeIcon(icon: string | null): string | null {
  return icon && /^data:image\/(png|jpeg|jpg|svg\+xml|webp|gif);/i.test(icon) ? icon : null;
}

function WalletGlyph({ wallet }: { wallet: DiscoveredWallet }) {
  const icon = safeIcon(wallet.icon);
  if (icon) {
    // eslint-disable-next-line @next/next/no-img-element -- a data URI, not an optimisable asset
    return <img src={icon} alt="" aria-hidden className="size-4 rounded" />;
  }
  return (
    <span
      aria-hidden
      className="grid size-4 place-items-center rounded bg-line text-[9px] font-semibold text-ink-muted"
    >
      {wallet.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function WalletPayPanel({
  target,
  priceUsd,
  verifying,
  disabled = false,
  onTxHash,
}: {
  target: WalletPaymentTarget;
  priceUsd: string;
  /** True while the parent is asking the server to verify. Owns the "Verifying payment…" line. */
  verifying: boolean;
  disabled?: boolean;
  /** Hands the hash to the server. Resolves once the verdict has been rendered by the parent. */
  onTxHash: (txHash: string) => Promise<void>;
}) {
  const [stage, setStage] = useState<Stage>("idle");
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const context = { networkLabel: target.networkLabel, asset: target.asset };
  const onRequiredChain = chainId === target.chainId;
  const canAddChain = KNOWN_EVM_CHAINS[target.chainId] !== undefined;

  /** Re-reads chain and balance. Both are display state; neither gates anything on the server. */
  const refresh = useCallback(
    async (provider: DiscoveredWallet["provider"], account: string) => {
      const nextChain = await readChainId(provider);
      setChainId(nextChain);
      if (nextChain !== target.chainId) {
        setBalance(null);
        return;
      }
      try {
        setBalance(
          await readTokenBalance(provider, { token: target.assetAddress, owner: account }),
        );
      } catch {
        // A node that will not answer `balanceOf` is not a reason to block a payment; the
        // balance line simply goes quiet. The wallet itself will refuse an unaffordable send.
        setBalance(null);
      }
    },
    [target.chainId, target.assetAddress],
  );

  // A payer who switches account or network in the wallet must not be shown stale details.
  useEffect(() => {
    if (!connection) return;
    const { provider } = connection.wallet;
    if (typeof provider.on !== "function" || typeof provider.removeListener !== "function") return;

    const onAccountsChanged = (...args: never[]) => {
      const accounts = args[0] as unknown;
      const next = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof next !== "string" || next === "") {
        setConnection(null);
        setChainId(null);
        setBalance(null);
        setStage("idle");
        return;
      }
      const account = next.toLowerCase();
      setConnection({ wallet: connection.wallet, account });
      void refresh(provider, account);
    };
    const onChainChanged = () => void refresh(provider, connection.account);

    provider.on("accountsChanged", onAccountsChanged);
    provider.on("chainChanged", onChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, [connection, refresh]);

  async function connect(wallet: DiscoveredWallet) {
    setError(null);
    setStage("connecting");
    try {
      const account = await requestAccounts(wallet.provider);
      setConnection({ wallet, account });
      await refresh(wallet.provider, account);
      setStage("ready");
    } catch (failure) {
      setError(classifyWalletError(failure, context).message);
      setStage(wallets.length > 1 ? "picking" : "idle");
    }
  }

  /** Scans for wallets. One found connects straight away; several present a picker. */
  async function scan() {
    setError(null);
    setStage("connecting");
    const host = browserWalletWindow();
    const found = host ? await discoverInjectedWallets(host) : [];
    setWallets(found);
    if (found.length === 0) {
      setError(WALLET_MESSAGES.unavailable);
      setStage("idle");
      return;
    }
    if (found.length === 1) {
      await connect(found[0] as DiscoveredWallet);
      return;
    }
    setStage("picking");
  }

  async function switchNetwork() {
    if (!connection) return;
    setError(null);
    setStage("switching");
    try {
      await switchToChain(connection.wallet.provider, target.chainId);
      await refresh(connection.wallet.provider, connection.account);
    } catch (failure) {
      setError(classifyWalletError(failure, context).message);
    } finally {
      setStage("ready");
    }
  }

  /**
   * Builds the transfer, asks the wallet to sign it, then hands the hash to the server.
   *
   * All of that lives in `payWithWallet`, which is where the sequence is tested. This function
   * only maps the outcome onto what the payer sees — including the two failures that must not look
   * like progress: a wrong chain (nothing was sent) and a rejected prompt (nothing was sent).
   */
  async function pay() {
    if (!connection) return;
    setError(null);
    setTxHash(null);
    setStage("waiting");
    const { provider } = connection.wallet;
    const outcome = await payWithWallet({
      provider,
      account: connection.account,
      target,
      // Only the hash crosses this line. The verdict comes back from the server.
      submit: async (hash) => {
        setTxHash(hash);
        setStage("submitted");
        await onTxHash(hash);
      },
    });
    if (outcome.status !== "submitted") {
      setError(outcome.message);
      setStage("ready");
      if (outcome.status === "wrong_network") setChainId(await readChainId(provider));
      return;
    }
    void refresh(provider, connection.account);
  }

  const affordable = balance === null || hasSufficientBalance(balance, target.amountBaseUnits);
  const busy = stage === "connecting" || stage === "switching" || stage === "waiting" || verifying;

  // ---- not connected -----------------------------------------------------------------
  if (!connection) {
    return (
      <div className="space-y-2">
        {stage === "picking" && wallets.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[11px] text-ink-faint">
              {wallets.length} wallets detected — choose which one pays.
            </p>
            {wallets.map((wallet) => (
              <Button
                key={wallet.id}
                variant="outline"
                size="md"
                onClick={() => void connect(wallet)}
                disabled={disabled || busy}
                icon={<WalletGlyph wallet={wallet} />}
                className="w-full justify-start"
              >
                Connect {wallet.name}
              </Button>
            ))}
          </div>
        ) : (
          <Button
            variant="primary"
            size="md"
            onClick={() => void scan()}
            disabled={disabled}
            loading={stage === "connecting"}
            className="w-full"
          >
            Connect Wallet
          </Button>
        )}
        {error ? <p className="text-[11px] text-rose">{error}</p> : null}
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Pays {priceUsd} in {target.asset} from your own wallet on {target.networkLabel}. Relayn
          never asks for a private key or a seed phrase and cannot move your funds.
        </p>
      </div>
    );
  }

  // ---- connected ---------------------------------------------------------------------
  return (
    <div className="space-y-2.5">
      <dl className="space-y-1 rounded-lg border border-line bg-base/40 p-2.5 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-faint">Connected</dt>
          <dd className="flex items-center gap-1.5 text-ink">
            <WalletGlyph wallet={connection.wallet} />
            <span className="numeric">{shortenAddress(connection.account)}</span>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-faint">Network</dt>
          <dd className={onRequiredChain ? "text-ink" : "text-amber"}>
            {chainId === null
              ? "Unknown"
              : onRequiredChain
                ? target.networkLabel
                : `Chain ${chainId} — not ${target.networkLabel}`}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-ink-faint">Balance</dt>
          <dd className={affordable ? "numeric text-ink" : "numeric text-rose"}>
            {balance === null
              ? "—"
              : `${formatWalletBalance(balance, target.assetDecimals)} ${target.asset}`}
          </dd>
        </div>
      </dl>

      {onRequiredChain ? (
        <Button
          variant="primary"
          size="md"
          onClick={() => void pay()}
          disabled={disabled || busy || !affordable}
          loading={stage === "waiting" || verifying}
          className="w-full"
        >
          Pay {priceUsd} {target.asset}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="md"
          onClick={() => void switchNetwork()}
          disabled={disabled || busy}
          loading={stage === "switching"}
          className="w-full"
        >
          Switch to {target.networkLabel}
        </Button>
      )}

      {!affordable ? (
        <p className="text-[11px] text-rose">{insufficientBalanceMessage(target.asset)}</p>
      ) : null}
      {!onRequiredChain && chainId !== null ? (
        <p className="text-[11px] text-amber">
          {wrongNetworkMessage(target.networkLabel)}
          {canAddChain ? "" : " Add the network in your wallet first."}
        </p>
      ) : null}
      {error ? <p className="text-[11px] text-rose">{error}</p> : null}

      {stage === "waiting" ? (
        <p className="text-[11px] text-amber">Waiting for wallet confirmation…</p>
      ) : null}

      {txHash ? (
        <div className="space-y-0.5 border-t border-line pt-2">
          <p className="text-[11px] text-ink-muted">Transaction submitted</p>
          <p className="numeric text-[11px] break-all text-ink-faint">{txHash}</p>
          {verifying ? <p className="text-[11px] text-amber">Verifying payment…</p> : null}
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-ink-faint">
        Sends {target.amountBaseUnits} base units of {target.asset} to the receiving address — a
        contract call, never a native transfer. Access is granted only after our server reads the
        transaction from the chain itself.
      </p>
    </div>
  );
}








