// Bridge Payment Gateway client (docs.bridgeagw.com)
// Same public surface as the old bulkclix.ts so call sites don't change:
//   initiateCheckout, checkStatus, normalizeGhanaPhone
const BASE = "https://api.bridgeagw.com";

export type Network = "MTN" | "TELECEL" | "AIRTELTIGO";

export function normalizeGhanaPhone(input: string): string | null {
  let p = String(input || "").replace(/\s+/g, "").replace(/^\+/, "");
  if (/^233\d{9}$/.test(p)) p = "0" + p.slice(3);
  if (!/^0\d{9}$/.test(p)) return null;
  return p;
}

function creds() {
  const id = Deno.env.get("BRIDGE_SERVICE_ID");
  const u = Deno.env.get("BRIDGE_USERNAME");
  const p = Deno.env.get("BRIDGE_PASSWORD");
  if (!id || !u || !p) throw new Error("Bridge credentials not configured");
  return { id: Number(id), auth: "Basic " + btoa(`${u}:${p}`) };
}

function bridgeNetwork(n: string): "MTN" | "VOD" | "AIR" {
  const s = String(n).toUpperCase();
  if (s === "MTN") return "MTN";
  if (s === "TELECEL" || s === "VOD" || s === "VODAFONE") return "VOD";
  return "AIR";
}

function callbackUrl() {
  const supa = Deno.env.get("SUPABASE_URL") || "";
  return `${supa}/functions/v1/bridge-webhook`;
}

function nowStamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export async function initiateCheckout(args: {
  amount: number;
  reference: string;
  phone: string;
  network: Network;
  nickname?: string;
  description?: string;
}) {
  const phone = normalizeGhanaPhone(args.phone);
  if (!phone) throw new Error("Invalid Ghana phone number. Use 0XXXXXXXXX");
  const { id, auth } = creds();
  const body = {
    service_id: id,
    reference: args.description ?? "Smart Deal Payment",
    customer_number: phone,
    transaction_id: args.reference,
    trans_type: "CTM",
    amount: Number(args.amount),
    nw: bridgeNetwork(args.network),
    nickname: args.nickname ?? "Smart Deal Customer",
    payment_option: "MOM",
    currency_code: "GHS",
    currency_val: "1",
    callback_url: callbackUrl(),
    request_time: nowStamp(),
  };
  const res = await fetch(`${BASE}/make_payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const code = String(json?.response_code ?? "");
  if (!res.ok || (code && code !== "202" && code !== "000")) {
    throw new Error(json?.response_message || `Bridge payment failed [${res.status}] ${text.slice(0, 200)}`);
  }
  return { transactionId: args.reference, raw: json };
}

// Bridge has no reliable public status-check endpoint yet; rely on the
// webhook. Verify polling reads payment_intents.status which the webhook
// updates. Return pending here so existing verify paths still short-circuit
// on already-persisted success/failed.
export async function checkStatus(_transactionId: string): Promise<{ status: "pending" | "success" | "failed"; raw?: any }> {
  return { status: "pending" };
}

// Map Bridge trans_status → our tri-state
export function mapTransStatus(s: string): "pending" | "success" | "failed" {
  const code = String(s || "").split("/")[0].trim();
  if (code === "000") return "success";
  if (code === "001" || code === "003") return "failed";
  return "pending";
}

export type Payout = { amount: number; reference: string; phone: string; network: Network; nickname?: string; description?: string };
export async function initiatePayout(args: Payout) {
  const phone = normalizeGhanaPhone(args.phone);
  if (!phone) throw new Error("Invalid Ghana phone number");
  const { id, auth } = creds();
  const body = {
    service_id: id,
    reference: args.description ?? "Smart Deal Payout",
    customer_number: phone,
    transaction_id: args.reference,
    trans_type: "MTC",
    amount: Number(args.amount),
    nw: bridgeNetwork(args.network),
    nickname: args.nickname ?? "Smart Deal Payout",
    payment_option: "MOM",
    currency_code: "GHS",
    currency_val: "1",
    callback_url: callbackUrl(),
    request_time: nowStamp(),
  };
  const res = await fetch(`${BASE}/make_payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const code = String(json?.response_code ?? "");
  if (!res.ok || (code && code !== "202" && code !== "000")) {
    throw new Error(json?.response_message || `Bridge payout failed [${res.status}]`);
  }
  return { transactionId: args.reference, raw: json };
}
