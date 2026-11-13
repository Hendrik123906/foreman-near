// Foreman — live, read-only NEAR integrations.
// 1. NEAR testnet account lookup via the public RPC (CORS-open, no key).
// 2. NEAR Intents 1Click dry quote (POST /v0/quote, dry=true: no execution,
//    no deposit, no tokens move). Mainnet only — Intents has no testnet.
// Everything else in the demo (escrow, payments) is simulated in-browser
// and labelled as such in the UI and README.

export interface TestnetAccount {
  accountId: string;
  balanceNEAR: string;
  lockedNEAR: string;
  storageUsage: number;
  blockHeight: number;
}

const YOCTO = BigInt(10) ** BigInt(24);

export function formatYocto(amount: string): string {
  try {
    const v = BigInt(amount);
    const whole = v / YOCTO;
    const frac = v % YOCTO;
    const fracStr = frac.toString().padStart(24, "0").slice(0, 4);
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return "0.0000";
  }
}

export async function lookupTestnetAccount(
  accountId: string,
): Promise<{ ok: true; account: TestnetAccount } | { ok: false; error: string }> {
  const id = accountId.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,64}$/.test(id)) {
    return { ok: false, error: "Account id tidak valid (2-64 karakter, huruf kecil, angka, . _ -)." };
  }
  try {
    const res = await fetch("https://rpc.testnet.near.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "foreman",
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: id },
      }),
    });
    const json = await res.json();
    if (json.error) {
      const msg = String(json.error?.data || json.error?.message || "akun tidak ditemukan");
      return { ok: false, error: `Testnet: ${msg}` };
    }
    const r = json.result;
    return {
      ok: true,
      account: {
        accountId: id,
        balanceNEAR: formatYocto(String(r.amount)),
        lockedNEAR: formatYocto(String(r.locked)),
        storageUsage: Number(r.storage_usage),
        blockHeight: Number(r.block_height),
      },
    };
  } catch {
    return { ok: false, error: "Tidak bisa menghubungi rpc.testnet.near.org — cek koneksi." };
  }
}

export interface IntentsQuote {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  timeEstimate: number;
}

/**
 * Dry quote: 1 USDC (Ethereum) -> wNEAR via NEAR Intents 1Click.
 * dry=true means the quote is computed only — no deposit address is funded
 * and nothing executes. The refund address below is a placeholder used only
 * for the dry-run validation; a dry quote never moves funds anywhere.
 */
export async function fetchIntentsQuote(
  usdc: number,
): Promise<{ ok: true; quote: IntentsQuote } | { ok: false; error: string }> {
  const amount = String(Math.round(usdc * 1_000_000));
  try {
    const res = await fetch("https://1click.chaindefuser.com/v0/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        depositType: "ORIGIN_CHAIN",
        destinationAsset: "nep141:wrap.near",
        amount,
        refundTo: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        recipient: "test.near",
        refundType: "ORIGIN_CHAIN",
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      }),
    });
    const json = await res.json();
    if (!res.ok || !json.quote) {
      return { ok: false, error: String(json?.message || "1Click tidak mengembalikan quote.") };
    }
    const q = json.quote;
    return {
      ok: true,
      quote: {
        amountIn: String(q.amountInFormatted ?? q.amountIn),
        amountInFormatted: String(q.amountInFormatted ?? q.amountIn),
        amountInUsd: String(q.amountInUsd ?? "?"),
        amountOutFormatted: String(q.amountOutFormatted ?? q.amountOut),
        amountOutUsd: String(q.amountOutUsd ?? "?"),
        timeEstimate: Number(q.timeEstimate ?? 0),
      },
    };
  } catch {
    return { ok: false, error: "Tidak bisa menghubungi 1Click API — cek koneksi." };
  }
}
