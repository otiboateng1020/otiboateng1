// Payment gateway selector.
// Set PAYMENT_GATEWAY=tpay | bulkclix | bridge to force one.
// Default: TPay when TPAY_CLIENT_ID is configured, then BulkClix, then Bridge.
import * as bridge from "./bridge.ts";
import * as bulkclix from "./bulkclix.ts";
import * as tpay from "./tpay.ts";

export type Network = "MTN" | "TELECEL" | "AIRTELTIGO";

export function gatewayName(): "tpay" | "bulkclix" | "bridge" {
  const pref = String(Deno.env.get("PAYMENT_GATEWAY") || "").toLowerCase();
  if (pref === "tpay") return "tpay";
  if (pref === "bridge") return "bridge";
  if (pref === "bulkclix") return "bulkclix";
  if (Deno.env.get("TPAY_CLIENT_ID")) return "tpay";
  return Deno.env.get("BULKCLIX_API_KEY") ? "bulkclix" : "bridge";
}

function impl() {
  const n = gatewayName();
  return n === "tpay" ? tpay : n === "bulkclix" ? bulkclix : bridge;
}

export const normalizeGhanaPhone = bridge.normalizeGhanaPhone;

export function initiateCheckout(args: {
  amount: number; reference: string; phone: string; network: Network;
  nickname?: string; description?: string;
}) {
  return impl().initiateCheckout(args);
}

export function checkStatus(transactionId: string) {
  return impl().checkStatus(transactionId);
}

export function initiatePayout(args: {
  amount: number; reference: string; phone: string; network: Network;
  nickname?: string; description?: string;
}) {
  // TPay cannot send money out; fall back to a payout-capable gateway when one
  // is configured, otherwise surface a clear "pay it manually" error.
  if (gatewayName() === "tpay") {
    if (Deno.env.get("BULKCLIX_API_KEY")) return bulkclix.initiatePayout(args);
    if (Deno.env.get("BRIDGE_SERVICE_ID")) return bridge.initiatePayout(args);
  }
  return impl().initiatePayout(args);
}
