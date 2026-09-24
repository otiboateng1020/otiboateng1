// Bridge Payment Gateway webhook
// POST https://<project>.supabase.co/functions/v1/bridge-webhook
// Bridge posts JSON with trans_ref (== our transaction_id) and trans_status.
// We look up the payment_intent (or agent_orders) and fulfil idempotently.
// deno-lint-ignore-file no-explicit-any
import { adminClient } from "../_shared/admin.ts";
import { handleOptions, json } from "../_shared/cors.ts";
import { mapTransStatus } from "../_shared/bridge.ts";
import { mapBulkclixStatus } from "../_shared/bulkclix.ts";
import { checkStatus } from "../_shared/gateway.ts";
import { createOrder as primeCreateOrder, isProviderInsufficient } from "../_shared/cheapdata.ts";

async function isDataManualMode(db: any): Promise<boolean> {
  const { data } = await db.from("site_settings").select("value").eq("key", "data_manual_mode").maybeSingle();
  const v = data?.value;
  return v === true || v === "true" || v === 1 || v === "1";
}

async function fulfilTopup(db: any, intent: any, raw: any) {
  const { data: updated } = await db.from("payment_intents").update({
    status: "success", webhook_payload: { ...(intent.webhook_payload ?? {}), callback: raw },
  }).eq("id", intent.id).eq("status", "pending").select("id").maybeSingle();
  if (!updated) return;
  const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", intent.user_id).maybeSingle();
  const newBal = Math.round((Number(wallet?.balance ?? 0) + Number(intent.net_amount)) * 100) / 100;
  await db.from("wallets").update({ balance: newBal }).eq("user_id", intent.user_id);
  await db.from("transactions").insert({
    user_id: intent.user_id, type: "topup", amount: Number(intent.net_amount), balance_after: newBal,
    reference: intent.reference, description: "Wallet top-up",
    meta: { paid: Number(intent.amount), fee: Number(intent.fee), credited: Number(intent.net_amount) },
  });
}

async function fulfilBuyDataMomo(db: any, intent: any, raw: any) {
  const wp = (intent.webhook_payload ?? {}) as any;
  const { data: updated } = await db.from("payment_intents").update({
    status: "success", webhook_payload: { ...wp, callback: raw },
  }).eq("id", intent.id).eq("status", "pending").select("id").maybeSingle();
  if (!updated) return;
  const { data: plan } = await db.from("data_plans").select("*").eq("id", wp.plan_id).maybeSingle();
  if (!plan) return;
  let order: any = null;
  if (wp.order_id) {
    const { data } = await db.from("orders").select("*").eq("id", wp.order_id).maybeSingle();
    order = data;
  }
  if (!order) {
    const { data: existing } = await db.from("orders").select("id").eq("api_reference", intent.reference).maybeSingle();
    if (existing) return;
    const { data: created } = await db.from("orders").insert({
      user_id: intent.user_id, network: plan.network,
      plan_id: plan.id, plan_code: plan.plan_code, plan_name: plan.name,
      phone: wp.recipient, amount_charged: Number(wp.price ?? intent.net_amount), api_cost: Number(plan.api_price),
      status: "pending", api_reference: intent.reference,
    }).select("*").single();
    order = created;
  }
  if (!order) return;
  const manualMode = await isDataManualMode(db);
  try {
    let apiRes: any = null; let apiStatus = "pending";
    if (!manualMode) {
      apiRes = await primeCreateOrder({ package_id: plan.plan_code, phone: order.phone, reference: intent.reference });
      apiStatus = String(apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
    }
    await db.from("orders").update({
      status: manualMode ? "pending" : (["completed", "success"].includes(apiStatus) ? "completed" : "processing"),
      api_response: apiRes ?? { manual: true, paid: "momo" },
    }).eq("id", order.id);
    await db.from("transactions").insert({
      user_id: intent.user_id, type: "purchase", amount: -Number(order.amount_charged),
      balance_after: null, reference: intent.reference,
      description: `${plan.network} · ${plan.name} · ${order.phone} (MoMo)`,
      meta: { order_id: order.id, plan_code: plan.plan_code, paid_via: "momo", gross: Number(intent.amount), fee: Number(intent.fee) },
    });
  } catch (e: any) {
    await db.from("orders").update({ status: "failed", api_response: { error: String(e?.message || e) } }).eq("id", order.id);
  }
}

// Store (agent link) order: created only after payment success.
async function fulfilStoreOrder(db: any, intent: any, raw: any) {
  const wp = (intent.webhook_payload ?? {}) as any;
  const { data: updated } = await db.from("payment_intents").update({
    status: "success", webhook_payload: { ...wp, callback: raw },
  }).eq("id", intent.id).eq("status", "pending").select("id").maybeSingle();
  if (!updated) return;
  const { data: existing } = await db.from("agent_orders").select("id").eq("payment_reference", intent.reference).maybeSingle();
  if (existing) return;
  const { data: order } = await db.from("agent_orders").insert({
    agent_id: wp.agent_id, plan_id: wp.plan_id,
    buyer_phone: wp.recipient, payment_phone: wp.payer, payment_network: wp.network,
    agent_price: Number(wp.agent_price), base_price: Number(wp.base_price), profit: Number(wp.profit),
    payment_reference: intent.reference, payment_status: "success",
  }).select("*").single();
  if (order) await deliverAgentOrder(db, order);
}

async function fulfilCreditSettle(db: any, intent: any, raw: any) {
  const wp = (intent.webhook_payload ?? {}) as any;
  const { data: updated } = await db.from("payment_intents").update({
    status: "success", webhook_payload: { ...wp, callback: raw },
  }).eq("id", intent.id).eq("status", "pending").select("id").maybeSingle();
  if (!updated) return;
  const paid = Number(intent.net_amount);
  const { data: cr } = await db.from("agent_credit").select("outstanding").eq("agent_id", intent.user_id).maybeSingle();
  const cur = Number(cr?.outstanding ?? 0);
  const nextOut = Math.max(0, Math.round((cur - paid) * 100) / 100);
  await db.from("agent_credit").update({ outstanding: nextOut, last_settled_at: new Date().toISOString() }).eq("agent_id", intent.user_id);
  await db.from("credit_orders_log").update({ settled: true, settled_at: new Date().toISOString(), settlement_reference: intent.reference })
    .eq("agent_id", intent.user_id).eq("settled", false);
  await db.from("transactions").insert({
    user_id: intent.user_id, type: "credit_settlement", amount: -paid, balance_after: null,
    reference: intent.reference, description: "Agent credit settlement",
  });
}

async function fulfilAgentOrder(db: any, order: any, raw: any) {
  const { data: updated } = await db.from("agent_orders").update({
    payment_status: "success",
  }).eq("id", order.id).eq("payment_status", "pending").select("id").maybeSingle();
  if (!updated) return;
  void raw;
  await deliverAgentOrder(db, order);
}

async function deliverAgentOrder(db: any, order: any) {
  const { data: plan } = await db.from("data_plans").select("*").eq("id", order.plan_id).maybeSingle();
  if (!plan) return;
  const primeRef = `AGN-D-${String(order.id).slice(0, 8)}-${Date.now().toString().slice(-6)}`;
  try {
    const apiRes = await primeCreateOrder({ package_id: plan.plan_code, phone: order.buyer_phone, reference: primeRef });
    const apiStatus = String(apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
    const success = apiRes?.success === true || ["success", "completed", "pending", "processing"].includes(apiStatus);
    if (!success) throw new Error(apiRes?.error ?? apiRes?.message ?? "delivery failed");
    const { data: intOrder } = await db.from("orders").insert({
      user_id: order.agent_id, network: plan.network, plan_id: plan.id, plan_code: plan.plan_code, plan_name: plan.name,
      phone: order.buyer_phone, amount_charged: Number(order.base_price), api_cost: Number(plan.api_price),
      status: ["completed", "success"].includes(apiStatus) ? "completed" : "processing",
      api_reference: primeRef, api_response: apiRes,
    }).select("id").single();
    const { data: ag } = await db.from("agents").select("profit_balance").eq("user_id", order.agent_id).maybeSingle();
    const newBal = Math.round((Number(ag?.profit_balance ?? 0) + Number(order.profit)) * 100) / 100;
    await db.from("agents").update({ profit_balance: newBal }).eq("user_id", order.agent_id);
    await db.from("agent_orders").update({ order_id: intOrder?.id ?? null, order_status: "completed" }).eq("id", order.id);
  } catch (e: any) {
    await db.from("agent_orders").update({ order_status: "delivery_failed", error: String(e?.message || e) }).eq("id", order.id);
  }
}

// Dial-in (USSD) order paid by mobile money: the pending order row already exists.
async function fulfilUssdOrder(db: any, order: any, raw: any) {
  const { data: claimed } = await db.from("orders")
    .update({ api_response: { ...(order.api_response ?? {}), callback: raw, paid: true } })
    .eq("id", order.id).eq("status", "pending").select("id").maybeSingle();
  if (!claimed) return;
  const manualMode = await isDataManualMode(db);
  try {
    let apiRes: any = null; let apiStatus = "pending";
    if (!manualMode) {
      apiRes = await primeCreateOrder({ package_id: order.plan_code, phone: order.phone, reference: order.api_reference });
      apiStatus = String(apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
      const ok = apiRes?.success === true || ["success", "completed", "pending", "processing"].includes(apiStatus);
      if (!ok) throw new Error(apiRes?.error ?? apiRes?.message ?? "delivery failed");
    }
    await db.from("orders").update({
      status: manualMode ? "pending" : (["completed", "success"].includes(apiStatus) ? "completed" : "processing"),
      api_response: { ...(order.api_response ?? {}), ...(apiRes ?? { manual: true }), channel: "ussd", paid_via: "momo", paid: true },
    }).eq("id", order.id);
    if (order.user_id) {
      await db.from("transactions").insert({
        user_id: order.user_id, type: "purchase", amount: -Number(order.amount_charged), balance_after: null,
        reference: order.api_reference,
        description: `${order.network} · ${order.plan_name} · ${order.phone} (USSD MoMo)`,
        meta: { order_id: order.id, plan_code: order.plan_code, paid_via: "momo", channel: "ussd" },
      });
    }
  } catch (e: any) {
    const msg = String(e?.message || e);
    // Paid but our provider wallet is empty: keep it queued so admin can retry after topping up.
    if (isProviderInsufficient(msg)) {
      await db.from("orders").update({
        status: "pending",
        api_response: { ...(order.api_response ?? {}), api_insufficient: true, error: msg, channel: "ussd", paid_via: "momo", paid: true },
      }).eq("id", order.id);
      return;
    }
    await db.from("orders").update({ status: "failed", api_response: { ...(order.api_response ?? {}), error: msg, channel: "ussd", paid: true } }).eq("id", order.id);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  let payload: any = {};
  try { payload = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  console.log("[bridge-webhook] payload:", JSON.stringify(payload));

  // Optional shared secret: when PAYMENT_WEBHOOK_SECRET is configured, the gateway
  // must present it (header or ?secret=) or the call is rejected outright.
  const sharedSecret = Deno.env.get("PAYMENT_WEBHOOK_SECRET");
  if (sharedSecret) {
    const url = new URL(req.url);
    const provided = req.headers.get("x-webhook-secret") || url.searchParams.get("secret") || "";
    const a = new TextEncoder().encode(provided);
    const b = new TextEncoder().encode(sharedSecret);
    let same = a.length === b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) same = false;
    }
    if (!same) return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Bridge: { trans_ref, trans_status }.  BulkClix: { data: { transaction_id, status } }.
  const bc = payload?.data ?? {};
  const ref = String(payload.trans_ref || payload.transaction_id || bc.transaction_id || "");
  if (!ref) return json({ ok: false, error: "Missing transaction reference" }, { status: 400 });
  const claimed = payload.trans_status !== undefined
    ? mapTransStatus(String(payload.trans_status || ""))
    : mapBulkclixStatus(String(bc.status ?? payload.status ?? ""));

  // NEVER trust the posted status. Always reconcile against the gateway's
  // authoritative status API before crediting wallets or delivering orders.
  let status: "pending" | "success" | "failed" = "pending";
  try {
    const verified = await checkStatus(ref);
    status = verified.status;
  } catch (e) {
    console.error("[bridge-webhook] status verification failed:", String((e as any)?.message || e));
    return json({ ok: false, error: "Could not verify payment" }, { status: 503 });
  }
  if (status !== claimed) {
    console.warn("[bridge-webhook] claimed status", claimed, "!= verified status", status, "for ref", ref);
  }
  if (status === "pending") return json({ ok: true, pending: true });

  const db = adminClient();

  // Try payment_intents first (topup, buy-data-momo, credit-settle)
  const { data: intent } = await db.from("payment_intents").select("*").eq("reference", ref).maybeSingle();
  if (intent) {
    if (intent.status === "success" || intent.status === "failed") return json({ ok: true, already: true });
    if (status === "failed") {
      await db.from("payment_intents").update({
        status: "failed", webhook_payload: { ...(intent.webhook_payload ?? {}), callback: payload },
      }).eq("id", intent.id).eq("status", "pending");
      return json({ ok: true });
    }
    if (status === "pending") return json({ ok: true, pending: true });
    // success
    const kind = String((intent.webhook_payload as any)?.kind || "");
    if (kind === "buy-data-momo") await fulfilBuyDataMomo(db, intent, payload);
    else if (kind === "store-order") await fulfilStoreOrder(db, intent, payload);
    else if (kind === "credit-settle") await fulfilCreditSettle(db, intent, payload);
    else await fulfilTopup(db, intent, payload); // default = topup
    return json({ ok: true });
  }

  // Try agent_orders (unauthenticated store checkout)
  const { data: order } = await db.from("agent_orders").select("*").eq("payment_reference", ref).maybeSingle();
  if (order) {
    if (order.payment_status === "success" || order.payment_status === "failed") return json({ ok: true, already: true });
    if (status === "failed") {
      await db.from("agent_orders").update({ payment_status: "failed" }).eq("id", order.id).eq("payment_status", "pending");
      return json({ ok: true });
    }
    if (status === "pending") return json({ ok: true, pending: true });
    await fulfilAgentOrder(db, order, payload);
    return json({ ok: true });
  }

  // Try dial-in (USSD) orders paid by mobile money — the order row itself holds the reference.
  const { data: ussdOrder } = await db.from("orders").select("*").eq("api_reference", ref).eq("source", "ussd").maybeSingle();
  if (ussdOrder) {
    if (ussdOrder.status !== "pending") return json({ ok: true, already: true });
    if (status === "failed") {
      await db.from("orders").update({ status: "failed", api_response: { ...(ussdOrder.api_response ?? {}), callback: payload } })
        .eq("id", ussdOrder.id).eq("status", "pending");
      return json({ ok: true });
    }
    await fulfilUssdOrder(db, ussdOrder, payload);
    return json({ ok: true });
  }

  console.warn("[bridge-webhook] no matching intent/order for ref:", ref);
  return json({ ok: true, unknown: true });
});
