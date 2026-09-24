// BulkClix Ghana payment client (https://developers.bulkclix.com)
// Same public surface as bridge.ts so call sites don't change:
//   initiateCheckout, checkStatus, normalizeGhanaPhone, initiatePayout
const BASE = "https://api.bulkclix.com/api/v1/payment-api";

export type Network = "MTN" | "TELECEL" | "AIRTELTIGO";

export function normalizeGhanaPhone(input: string): string | null {
  let p = String(input || "").replace(/\s+/g, "").replace(/^\+/, "");
  if (/^233\d{9}$/.test(p)) p = "0" + p.slice(3);
  if (!/^0\d{9}$/.test(p)) return null;
  return p;
}

function apiKey() {
  const k = Deno.env.get("BULKCLIX_API_KEY");
  if (!k) throw new Error("BulkClix is not configured");
  return k;
}

function bcNetwork(n: string): Network {
  const s = String(n).toUpperCase();
  if (s === "MTN") return "MTN";
  if (s === "TELECEL" || s === "VOD" || s === "VODAFONE") return "TELECEL";
  return "AIRTELTIGO";
}

function callbackUrl() {
  const supa = Deno.env.get("SUPABASE_URL") || "";
  return `${supa}/functions/v1/bridge-webhook`;
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

  const res = await fetch(`${BASE}/momopay`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: Number(args.amount),
      phone_number: phone,
      network: bcNetwork(args.network),
      transaction_id: args.reference,
      callback_url: callbackUrl(),
      reference: args.description ?? "Smart Deal",
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(json?.message || `BulkClix payment failed [${res.status}] ${text.slice(0, 200)}`);
  }
  return { transactionId: args.reference, raw: json };
}

export async function checkStatus(
  transactionId: string,
): Promise<{ status: "pending" | "success" | "failed"; raw?: any }> {
  try {
    const res = await fetch(`${BASE}/checkstatus/${encodeURIComponent(transactionId)}`, {
      method: "GET",
      headers: { "x-api-key": apiKey(), Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) return { status: "pending", raw: json };
    const data = json?.data ?? json;
    return { status: mapBulkclixStatus(String(data?.status || "")), raw: json };
  } catch (_e) {
    return { status: "pending" };
  }
}

export function mapBulkclixStatus(s: string): "pending" | "success" | "failed" {
  const v = String(s || "").toLowerCase();
  if (v === "success" || v === "successful" || v === "completed" || v === "paid") return "success";
  if (v === "failed" || v === "cancelled" || v === "canceled" || v === "declined") return "failed";
  return "pending";
}

export type Payout = {
  amount: number;
  reference: string;
  phone: string;
  network: Network;
  nickname?: string;
  description?: string;
};

// Mobile-money payout (send money). BulkClix: POST /send-money/mobilemoney
export async function initiatePayout(args: Payout) {
  const phone = normalizeGhanaPhone(args.phone);
  if (!phone) throw new Error("Invalid Ghana phone number");
  const res = await fetch(`${BASE}/send-money/mobilemoney`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      account_number: phone,
      account_name: args.nickname ?? "Smart Deal Payout",
      channel: bcNetwork(args.network),
      amount: String(args.amount),
      client_reference: args.reference,
      narration: args.description ?? "Smart Deal payout",
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.message || `BulkClix payout failed [${res.status}]`);
  return { transactionId: args.reference, raw: json };
}
