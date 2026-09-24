// TPay (MomoPOS / TheTeller) v2 payment client — live mode.
// Docs: https://dashboard.momopos.theteller.net/docs/api?payment_mode=live
// Same public surface as bridge.ts / bulkclix.ts so call sites don't change:
//   initiateCheckout, checkStatus, normalizeGhanaPhone, initiatePayout
const BASE = (Deno.env.get("TPAY_BASE_URL") || "https://api.momopos.theteller.net").replace(/\/+$/, "");

export type Network = "MTN" | "TELECEL" | "AIRTELTIGO";

export function normalizeGhanaPhone(input: string): string | null {
  let p = String(input || "").replace(/\s+/g, "").replace(/^\+/, "");
  if (/^233\d{9}$/.test(p)) p = "0" + p.slice(3);
  if (!/^0\d{9}$/.test(p)) return null;
  return p;
}

/** 0XXXXXXXXX -> 233XXXXXXXXX (the format TPay expects). */
function msisdn(local: string) {
  return "233" + local.slice(1);
}

function creds() {
  const id = Deno.env.get("TPAY_CLIENT_ID");
  const secret = Deno.env.get("TPAY_CLIENT_SECRET");
  const terminal = Deno.env.get("TPAY_TERMINAL_ID");
  if (!id || !secret || !terminal) throw new Error("TPay is not configured");
  return { id, secret, terminal };
}

function rSwitch(n: string): "MTN" | "VDF" | "ATG" {
  const s = String(n).toUpperCase();
  if (s === "MTN") return "MTN";
  if (s === "TELECEL" || s === "VOD" || s === "VODAFONE") return "VDF";
  return "ATG";
}

function callbackUrl() {
  const supa = Deno.env.get("SUPABASE_URL") || "";
  return `${supa}/functions/v1/bridge-webhook`;
}

// Token cache — the API asks integrators to reuse tokens until shortly before expiry.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const { id, secret } = creds();
  const form = new URLSearchParams({ client_id: id, client_secret: secret });
  const res = await fetch(`${BASE}/gen-token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let j: any; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  const value = j?.access_token;
  if (!res.ok || !value) {
    throw new Error(j?.reason || j?.message || `TPay auth failed [${res.status}] ${text.slice(0, 200)}`);
  }
  const ttl = Math.max(60, Number(j?.expires_in ?? 3600));
  cachedToken = { value, expiresAt: Date.now() + (ttl - 60) * 1000 };
  return value;
}

async function authed(path: string, init: RequestInit = {}, retry = true): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${await token()}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let j: any; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  // 979 = expired/invalid token: mint a fresh one once and retry.
  if (retry && (res.status === 401 || String(j?.code) === "979")) {
    cachedToken = null;
    return authed(path, init, false);
  }
  return { httpStatus: res.status, ok: res.ok, body: j, text };
}

/** TPay transaction_id must be 12–255 characters. */
function txId(reference: string) {
  const r = String(reference).replace(/[^A-Za-z0-9-]/g, "");
  return r.length >= 12 ? r.slice(0, 255) : (r + "0".repeat(12)).slice(0, 12);
}

/** desc must be 10–100 characters. */
function desc(input: string | undefined) {
  const d = String(input || "Smart Deal payment");
  return d.length < 10 ? (d + " payment").padEnd(10, " ").slice(0, 100) : d.slice(0, 100);
}

export async function initiateCheckout(args: {
  amount: number;
  reference: string;
  phone: string;
  network: Network;
  nickname?: string;
  description?: string;
}) {
  const local = normalizeGhanaPhone(args.phone);
  if (!local) throw new Error("Invalid Ghana phone number. Use 0XXXXXXXXX");
  const { terminal } = creds();
  const transaction_id = txId(args.reference);

  const r = await authed(`/process/tpay-v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Number(args.amount).toFixed(2),
      processing_code: "000200",
      r_switch: rSwitch(args.network),
      pos_terminal_id: terminal,
      voucher_code: "",
      transaction_id,
      subscriber_number: msisdn(local),
      desc: desc(args.description),
      currency: "GHS",
      callback: callbackUrl(),
      reference: String(args.reference).slice(0, 30),
      timestamp: new Date().toISOString(),
    }),
  });

  const code = String(r.body?.code ?? "");
  // 200 = accepted/queued, 000 = already approved.
  if (!r.ok || (code !== "200" && code !== "000")) {
    throw new Error(r.body?.reason || r.body?.message || `Payment failed [${r.httpStatus}] ${String(r.text).slice(0, 200)}`);
  }
  return { transactionId: transaction_id, raw: r.body };
}

export function mapTpayCode(code: string): "pending" | "success" | "failed" {
  const c = String(code || "").trim();
  if (c === "000") return "success";
  if (c === "101" || c === "200") return "pending";
  if (c === "401") return "pending"; // not found yet — keep polling
  return "failed";
}

export async function checkStatus(
  transactionId: string,
): Promise<{ status: "pending" | "success" | "failed"; raw?: any }> {
  try {
    const r = await authed(`/process/check-status/${encodeURIComponent(txId(transactionId))}`, { method: "GET" });
    if (!r.ok && r.httpStatus >= 500) return { status: "pending", raw: r.body };
    return { status: mapTpayCode(String(r.body?.code ?? "")), raw: r.body };
  } catch (_e) {
    return { status: "pending" };
  }
}

export type Payout = {
  amount: number;
  reference: string;
  phone: string;
  network: Network;
  nickname?: string;
  description?: string;
};

// TPay v2 is collections-only (transfer processing codes are rejected).
export async function initiatePayout(_args: Payout): Promise<never> {
  throw new Error("Automatic payouts are not available on this payment provider. Pay withdrawals out manually.");
}

/** Credential check: mints a token without moving any money. */
export async function ping(): Promise<{ ok: boolean; base: string; error?: string }> {
  try {
    await token();
    return { ok: true, base: BASE };
  } catch (e) {
    return { ok: false, base: BASE, error: String((e as Error).message).slice(0, 200) };
  }
}
