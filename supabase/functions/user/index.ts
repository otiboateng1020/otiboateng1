// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { adminClient, requireUser } from "../_shared/admin.ts";
import { handleOptions, json } from "../_shared/cors.ts";
import { initiateCheckout, checkStatus, normalizeGhanaPhone, gatewayName } from "../_shared/gateway.ts";
import { createOrder as primeCreateOrder, getOrderStatus as primeOrderStatus } from "../_shared/cheapdata.ts";
import { placeOrder as smmPlaceOrder, getOrderStatus as smmOrderStatus, ALLOWED_PLATFORMS } from "../_shared/netwave.ts";
import { getBusinessSettings, computeStatus, computeStoreStatus, getPaymentSettings } from "../_shared/business.ts";

async function getAgentCreditRow(db: any, agentId: string) {
  const { data } = await db.from("agent_credit").select("*").eq("agent_id", agentId).maybeSingle();
  return data;
}
async function ensureOrdersAllowed(db: any, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const settings = await getBusinessSettings(db);
  const st = computeStatus(settings);
  if (!st.open) {
    // Closed platform: block all order placement (users AND agents).
    return { ok: false, error: "The platform is currently closed. Please try again during business hours." };
  }
  // If open, block agent with unpaid credit? No — only past-close restriction. Open = allowed.
  return { ok: true };
}
async function ensureUserOrderTypeAllowed(db: any, userId: string, type: "data" | "smm"): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await db.from("profiles")
    .select("is_banned,data_orders_blocked,smm_orders_blocked")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: "Could not verify your ordering access. Please try again." };
  if (data.is_banned) return { ok: false, error: "Your account is blocked from placing orders. Please contact support." };
  if (type === "data" && data.data_orders_blocked) {
    return { ok: false, error: "Data ordering is disabled for your account. Please contact support." };
  }
  if (type === "smm" && data.smm_orders_blocked) {
    return { ok: false, error: "Social boosting orders are disabled for your account. Please contact support." };
  }
  return { ok: true };
}
async function addToCreditOutstanding(db: any, agentId: string, delta: number) {
  const { data: cur } = await db.from("agent_credit").select("outstanding").eq("agent_id", agentId).maybeSingle();
  const next = Math.round(((Number(cur?.outstanding ?? 0)) + delta) * 100) / 100;
  await db.from("agent_credit").update({ outstanding: Math.max(0, next) }).eq("agent_id", agentId);
  return next;
}

function feeFor(amount: number): number {
  // Processing fee: flat 0.5% of the amount (Bridge charges 1.5% → 2% total)
  return Math.round(amount * 0.005 * 100) / 100;
}

async function refundOrder(db: any, order: any) {
  const { data: w } = await db.from("wallets").select("balance").eq("user_id", order.user_id).maybeSingle();
  const bal = Number(w?.balance ?? 0);
  const refund = Number(order.amount_charged);
  const newBal = Math.round((bal + refund) * 100) / 100;
  await db.from("wallets").update({ balance: newBal }).eq("user_id", order.user_id);
  await db.from("transactions").insert({
    user_id: order.user_id, type: "refund", amount: refund, balance_after: newBal,
    reference: order.api_reference, description: `Refund: ${order.plan_name} (${order.network})`,
    meta: { order_id: order.id },
  });
}

async function isDataManualMode(db: any): Promise<boolean> {
  const { data } = await db.from("site_settings").select("value").eq("key", "data_manual_mode").maybeSingle();
  const v = data?.value;
  return v === true || v === "true" || v === 1 || v === "1";
}

async function isAgentUser(db: any, userId: string): Promise<boolean> {
  const { data } = await db.from("agents").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}
function planPriceFor(plan: any, isAgent: boolean): number {
  return isAgent && plan.agent_price != null ? Number(plan.agent_price) : Number(plan.custom_price);
}

function normalizeOrderPhone(input: string): string | null {
  return normalizeGhanaPhone(input);
}

// Returns array of phones (from the input) that still have an order in progress.
// A number is reusable once its previous orders are completed, failed or refunded.
async function phonesWithActiveOrders(db: any, phones: string[]): Promise<string[]> {
  const uniq = Array.from(new Set(phones.map((p) => normalizeOrderPhone(String(p || ""))).filter(Boolean) as string[]));
  if (uniq.length === 0) return [];
  const [ordersRes, agentOrdersRes] = await Promise.all([
    db.from("orders")
      .select("phone,status")
      .in("phone", uniq)
      .in("status", ["pending", "processing"])
      .limit(1000),
    db.from("agent_orders")
      .select("buyer_phone,order_status,payment_status")
      .in("buyer_phone", uniq)
      .in("order_status", ["pending", "processing"])
      .limit(1000),
  ]);
  if (ordersRes.error) throw new Error(`Order validation failed: ${ordersRes.error.message}`);
  if (agentOrdersRes.error) throw new Error(`Store order validation failed: ${agentOrdersRes.error.message}`);
  const busy = new Set<string>();
  for (const r of (ordersRes.data ?? [])) busy.add(String(r.phone));
  for (const r of (agentOrdersRes.data ?? [])) busy.add(String(r.buyer_phone));
  return uniq.filter((p) => busy.has(p));
}

// Creates the store order row only after payment has actually succeeded, then delivers it.
async function createPaidStoreOrder(db: any, reference: string, wp: any) {
  const { data: existing } = await db.from("agent_orders").select("id").eq("payment_reference", reference).maybeSingle();
  if (existing) return;
  const { data: order } = await db.from("agent_orders").insert({
    agent_id: wp.agent_id, plan_id: wp.plan_id,
    buyer_phone: wp.recipient, payment_phone: wp.payer, payment_network: wp.network,
    agent_price: Number(wp.agent_price), base_price: Number(wp.base_price), profit: Number(wp.profit),
    payment_reference: reference, payment_status: "success",
  }).select("*").single();
  if (!order) return;
  const { data: plan } = await db.from("data_plans").select("*").eq("id", order.plan_id).maybeSingle();
  if (!plan) return;
  const primeRef = `AGN-D-${String(order.id).slice(0, 8)}-${Date.now().toString().slice(-6)}`;
  try {
    const apiRes = await primeCreateOrder({ package_id: plan.plan_code, phone: order.buyer_phone, reference: primeRef });
    const apiStatus = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
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

// Creates the customer's data order only after MoMo payment succeeded, then delivers it.
async function createPaidMomoOrder(db: any, intent: any, wp: any) {
  const { data: plan } = await db.from("data_plans").select("*").eq("id", wp.plan_id).maybeSingle();
  if (!plan) return;
  let order: any = null;
  if (wp.order_id) {
    const { data } = await db.from("orders").select("*").eq("id", wp.order_id).maybeSingle();
    order = data;
  }
  if (!order) {
    const { data: existing } = await db.from("orders").select("*").eq("api_reference", intent.reference).maybeSingle();
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
    let apiRes: any = null;
    let apiStatus = "pending";
    if (!manualMode) {
      apiRes = await primeCreateOrder({ package_id: plan.plan_code, phone: order.phone, reference: intent.reference });
      apiStatus = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
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





Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const db = adminClient();

    // Business-hours gate for order-placement actions (blocks when closed).
    const ORDER_ACTIONS = new Set([
      "buy-data", "buy-data-momo-initiate",
      "bulk-buy-data", "bulk-buy-mixed",
      "smm-create-order",
      "store-initiate",
    ]);
    if (ORDER_ACTIONS.has(action)) {
      const s = await getBusinessSettings(db);
      const st = computeStatus(s);
      if (!st.open) return json({ ok: false, error: "The platform is currently closed. Please try again during business hours." });
    }

    // Platform-wide mobile-money payment switch (admin > Site settings > Payments).
    const PAYMENT_ACTIONS = new Set([
      "topup-initiate", "buy-data-momo-initiate", "store-initiate",
      "agent-credit-pay-initiate", "ussd-pay-initiate",
    ]);
    if (PAYMENT_ACTIONS.has(action)) {
      const pay = await getPaymentSettings(db);
      if (!pay.enabled) return json({ ok: false, error: pay.message, payments_closed: true });
    }

    // ---- Internal dial-in (USSD) actions: called by the site server with the service-role key.
    // The payment/data-provider credentials only exist here, so the USSD engine delegates to us.
    if (action === "ussd-pay-initiate" || action === "ussd-deliver") {
      const auth = req.headers.get("authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      let trusted = !!serviceKey && token === serviceKey;
      if (!trusted && token) {
        // Site server and functions runtime can hold different key formats.
        // Accept any token that actually grants service-role access.
        try {
          const probe = createClient(Deno.env.get("SUPABASE_URL")!, token, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
          trusted = !error;
        } catch { trusted = false; }
      }
      if (!trusted) return json({ ok: false, error: "Unauthorized" }, { status: 401 });

      const orderId = String(body.order_id || "");
      const { data: order } = await db.from("orders").select("*").eq("id", orderId).maybeSingle();
      if (!order || order.source !== "ussd") return json({ ok: false, error: "Order not found" });
      if (order.status !== "pending") return json({ ok: false, error: "Order is not pending" });

      if (action === "ussd-pay-initiate") {
        const payer = normalizeGhanaPhone(String(order.payer_phone || ""));
        if (!payer) return json({ ok: false, error: "Invalid payer number" });
        const payNetwork = String(body.pay_network || "MTN").toUpperCase();
        try {
          const r = await initiateCheckout({
            amount: Number(order.amount_charged),
            reference: String(order.api_reference || order.id),
            phone: payer,
            network: (["MTN", "TELECEL", "AIRTELTIGO"].includes(payNetwork) ? payNetwork : "MTN") as any,
          });
          await db.from("orders").update({
            api_response: { ...(order.api_response ?? {}), transactionId: r.transactionId, gateway: gatewayName() },
          }).eq("id", order.id);
          return json({ ok: true });
        } catch (e: any) {
          const msg = String(e?.message || e);
          await db.from("orders").update({ status: "failed", api_response: { ...(order.api_response ?? {}), error: msg } }).eq("id", order.id);
          return json({ ok: false, error: msg });
        }
      }

      // ussd-deliver: wallet-paid dial-in order goes straight to the data provider.
      if (await isDataManualMode(db)) return json({ ok: true, manual: true });
      try {
        const apiRes: any = await primeCreateOrder({
          package_id: order.plan_code, phone: order.phone, reference: String(order.api_reference || order.id),
        });
        const apiStatus = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
        const ok = apiRes?.success === true || ["success", "completed", "pending", "processing"].includes(apiStatus);
        if (!ok) throw new Error(apiRes?.error ?? apiRes?.message ?? "delivery failed");
        await db.from("orders").update({
          status: ["completed", "success"].includes(apiStatus) ? "completed" : "processing",
          api_response: { ...(order.api_response ?? {}), ...apiRes, channel: "ussd", paid: true },
        }).eq("id", order.id);
        return json({ ok: true });
      } catch (e: any) {
        const msg = String(e?.message || e);
        const { isProviderInsufficient } = await import("../_shared/cheapdata.ts");
        if (isProviderInsufficient(msg)) {
          await db.from("orders").update({
            status: "pending",
            api_response: { ...(order.api_response ?? {}), api_insufficient: true, error: msg, channel: "ussd", paid: true },
          }).eq("id", order.id);
          return json({ ok: true, queued: true });
        }
        await db.from("orders").update({ status: "failed", api_response: { ...(order.api_response ?? {}), error: msg, channel: "ussd", paid: true } }).eq("id", order.id);
        return json({ ok: false, error: msg });
      }
    }

    // Public reads (no auth)
    if (action === "list-plans") {
      // Auth-aware: if the caller is an agent, return agent_price; else customer custom_price.
      const maybeUser = await requireUser(req).catch(() => null);
      let isAgent = false;
      if (maybeUser) {
        const { data: ag } = await db.from("agents").select("user_id").eq("user_id", maybeUser.userId).maybeSingle();
        isAgent = !!ag;
      }
      const { data } = await db
        .from("data_plans")
        .select("id,network,plan_code,name,size,validity,custom_price,agent_price,active,sort_order")
        .eq("active", true)
        .order("network").order("sort_order").order("custom_price");
      const plans = (data ?? []).map((p: any) => ({
        id: p.id, network: p.network, plan_code: p.plan_code, name: p.name,
        size: p.size, validity: p.validity, active: p.active, sort_order: p.sort_order,
        custom_price: isAgent && p.agent_price != null ? Number(p.agent_price) : Number(p.custom_price),
        role: isAgent ? "agent" : "customer",
      }));
      return json({ ok: true, plans, role: isAgent ? "agent" : "customer" });
    }

    if (action === "get-announcement") {
      const { data } = await db.from("site_settings").select("value").eq("key", "announcement").maybeSingle();
      const v = (data?.value ?? {}) as any;
      return json({
        ok: true,
        announcement: {
          enabled: !!v.enabled,
          version: Number(v.version ?? 1),
          title: String(v.title ?? ""),
          body: String(v.body ?? ""),
          community_text: String(v.community_text ?? "Join our community"),
          community_link: String(v.community_link ?? ""),
        },
      });
    }



    // === MNP (Mobile Number Portability) lookup ===
    // Verifies whether a Ghana number has been ported to a specific network.
    // Requires MNP_API_URL (+ optional MNP_API_KEY / MNP_API_KEY_HEADER) secrets.
    // Response: { ok, status: "ported"|"not_ported"|"unavailable"|"invalid", carrier?, detected? }
    if (action === "mnp-verify") {
      const raw = String(body.phone || "").replace(/\D/g, "");
      const target = String(body.network || "").toUpperCase();
      if (!raw) return json({ ok: false, error: "Missing phone" });
      const normalized = raw.startsWith("233") ? raw : (raw.startsWith("0") ? "233" + raw.slice(1) : "233" + raw);
      const url = Deno.env.get("MNP_API_URL");
      if (!url) return json({ ok: true, status: "unavailable", reason: "MNP lookup not configured" });
      try {
        const headers: Record<string, string> = { "Accept": "application/json" };
        const apiKey = Deno.env.get("MNP_API_KEY");
        const keyHeader = Deno.env.get("MNP_API_KEY_HEADER") || "Authorization";
        if (apiKey) headers[keyHeader] = keyHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey;
        const u = url.includes("{msisdn}") ? url.replace("{msisdn}", normalized) : `${url}${url.includes("?") ? "&" : "?"}msisdn=${normalized}`;
        const res = await fetch(u, { headers });
        const data = await res.json().catch(() => ({}));
        // Try to extract carrier name from common shapes
        const carrier: string = String(
          data?.current_carrier?.name ??
          data?.mccmnc_ported?.network_name ??
          data?.carrier?.name ??
          data?.network ??
          data?.operator ??
          data?.mnp?.network ??
          ""
        ).toUpperCase();
        const canonical =
          carrier.includes("MTN") ? "MTN" :
          carrier.includes("TELECEL") || carrier.includes("VODAFONE") ? "TELECEL" :
          carrier.includes("AIRTEL") || carrier.includes("TIGO") ? "AIRTELTIGO" :
          "";
        if (!canonical) return json({ ok: true, status: "unavailable", reason: "Could not parse MNP response", raw: data });
        const matches = canonical === target;
        return json({ ok: true, status: matches ? "ported" : "not_ported", carrier: canonical, detected: canonical });
      } catch (e: any) {
        return json({ ok: true, status: "unavailable", reason: String(e?.message || e) });
      }
    }


    if (action === "preview-fee") {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json({ ok: false, error: "Invalid amount" });
      const fee = feeFor(amount);
      // Fee is added ON TOP: user pays (amount + fee); wallet is credited with the full `amount`.
      return json({ ok: true, fee, credit: amount, total: Math.round((amount + fee) * 100) / 100, net: amount });
    }

    // ================ PUBLIC AGENT STORE ================
    if (action === "store-get") {
      const name = String(body.store_name || "").trim().toLowerCase();
      if (!name) return json({ ok: false, error: "Missing store" });
      const STORE_COLS = "user_id,store_name,whatsapp_link,contact_number,global_markup_percent,auto_markup,active,store_open_time,store_close_time,store_hours_mode";
      let { data: agent } = await db.from("agents")
        .select(STORE_COLS)
        .ilike("store_name", name).eq("active", true).maybeSingle();
      // Fallback: allow lookup by the agent's username
      if (!agent) {
        const { data: prof } = await db.from("profiles").select("id").ilike("username", name).maybeSingle();
        if (prof) {
          const r = await db.from("agents")
            .select(STORE_COLS)
            .eq("user_id", prof.id).eq("active", true).maybeSingle();
          agent = r.data;
        }
      }
      if (!agent) return json({ ok: false, error: "Store not found" }, { status: 404 });
      // If store_name isn't set yet, expose the requested name so the page still renders
      if (!agent.store_name) agent.store_name = name;

      const [plans, overrides] = await Promise.all([
        db.from("data_plans").select("id,network,plan_code,name,size,validity,custom_price,agent_price,active,sort_order").eq("active", true).order("network").order("sort_order"),
        db.from("agent_plans").select("plan_id,agent_price,markup_percent,active").eq("agent_id", agent.user_id),
      ]);
      const ovMap = new Map<string, any>((overrides.data ?? []).map((o: any) => [o.plan_id, o]));
      const gm = Number(agent.global_markup_percent || 0);
      const out = (plans.data ?? []).map((p: any) => {
        const ov = ovMap.get(p.id);
        const base = p.agent_price != null ? Number(p.agent_price) : Number(p.custom_price);
        let price = base + (base * gm) / 100;
        let active = true;
        if (ov) {
          if (ov.active === false) active = false;
          if (ov.agent_price != null) price = Number(ov.agent_price);
          else if (ov.markup_percent != null) price = base + (base * Number(ov.markup_percent)) / 100;
        }
        return { id: p.id, network: p.network, name: p.name, size: p.size, validity: p.validity, price: Math.round(price * 100) / 100, active };
      }).filter((p: any) => p.active);
      return json({
        ok: true,
        store: { name: agent.store_name, whatsapp: agent.whatsapp_link, contact: agent.contact_number },
        status: computeStoreStatus(agent.store_open_time, agent.store_close_time, agent.store_hours_mode),
        payments: await getPaymentSettings(db),
        plans: out,
      });
    }

    if (action === "store-initiate") {
      const store = String(body.store_name || "").trim().toLowerCase();
      const plan_id = String(body.plan_id || "");
      const recipient = normalizeOrderPhone(String(body.recipient || ""));
      const payer = normalizeGhanaPhone(String(body.payer || ""));
      const network = String(body.network || "MTN").toUpperCase();
      if (!store || !plan_id || !recipient || !payer) return json({ ok: false, error: "Missing or invalid fields" });
      if (!["MTN", "TELECEL", "AIRTELTIGO"].includes(network)) return json({ ok: false, error: "Invalid network" });
      {
        const busy = await phonesWithActiveOrders(db, [recipient]);
        if (busy.length) return json({ ok: false, error: `${recipient} has an unfinished order. Please wait until it is completed.` });
      }
      let { data: agent } = await db.from("agents").select("*").ilike("store_name", store).eq("active", true).maybeSingle();
      if (!agent) {
        const { data: prof } = await db.from("profiles").select("id").ilike("username", store).maybeSingle();
        if (prof) {
          const r = await db.from("agents").select("*").eq("user_id", prof.id).eq("active", true).maybeSingle();
          agent = r.data;
        }
      }
      if (!agent) return json({ ok: false, error: "Store not found" });
      {
        const ss = computeStoreStatus(agent.store_open_time, agent.store_close_time, agent.store_hours_mode);
        if (!ss.open) return json({ ok: false, error: `This store is currently closed. Opening hours: ${ss.openTime} - ${ss.closeTime} (Ghana time).` });
      }
      const { data: plan } = await db.from("data_plans").select("*").eq("id", plan_id).maybeSingle();
      if (!plan || plan.active === false) return json({ ok: false, error: "Plan unavailable" });
      const { data: ov } = await db.from("agent_plans").select("*").eq("agent_id", agent.user_id).eq("plan_id", plan_id).maybeSingle();
      const base = plan.agent_price != null ? Number(plan.agent_price) : Number(plan.custom_price);
      const gm = Number(agent.global_markup_percent || 0);
      let agent_price = base + (base * gm) / 100;
      if (ov) {
        if (ov.active === false) return json({ ok: false, error: "Plan unavailable" });
        if (ov.agent_price != null) agent_price = Number(ov.agent_price);
        else if (ov.markup_percent != null) agent_price = base + (base * Number(ov.markup_percent)) / 100;
      }
      agent_price = Math.round(agent_price * 100) / 100;
      const fee = feeFor(agent_price);
      const gross = Math.round((agent_price + fee) * 100) / 100;
      const reference = `AGN${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
      // No order row is created yet — the store order is only recorded after payment succeeds.
      const { error: pErr } = await db.from("payment_intents").insert({
        user_id: agent.user_id, provider: gatewayName(), reference,
        amount: gross, fee, net_amount: agent_price, status: "pending",
        webhook_payload: {
          kind: "store-order", agent_id: agent.user_id, plan_id: plan.id,
          recipient, payer, network, agent_price, base_price: base,
          profit: Math.round((agent_price - base) * 100) / 100,
        },
      });
      if (pErr) {
        console.error("[store-initiate] intent insert failed:", pErr, { agent_id: agent.user_id, plan_id: plan.id, reference });
        return json({ ok: false, error: `Could not start payment: ${pErr.message || "db error"}` });
      }

      try {
        const r = await initiateCheckout({ amount: gross, reference, phone: payer, network: network as any });
        await db.from("payment_intents").update({
          webhook_payload: {
            kind: "store-order", agent_id: agent.user_id, plan_id: plan.id,
            recipient, payer, network, agent_price, base_price: base,
            profit: Math.round((agent_price - base) * 100) / 100,
            transactionId: r.transactionId,
          },
        }).eq("reference", reference);
        return json({ ok: true, reference, agent_price });
      } catch (e: any) {
        await db.from("payment_intents").update({ status: "failed", webhook_payload: { kind: "store-order", error: String(e?.message || e) } }).eq("reference", reference);
        return json({ ok: false, error: String(e?.message || e) });
      }
    }

    if (action === "store-verify") {
      const reference = String(body.reference || "");
      const { data: intent } = await db.from("payment_intents").select("*").eq("reference", reference).maybeSingle();
      if (!intent) return json({ ok: false, status: "not_found" });
      const wp = (intent.webhook_payload ?? {}) as any;
      if (intent.status === "failed") return json({ ok: true, status: "failed" });
      if (intent.status === "success") {
        const { data: existing } = await db.from("agent_orders").select("order_id").eq("payment_reference", reference).maybeSingle();
        return json({ ok: true, status: "success", delivered: !!existing?.order_id });
      }
      const st = await checkStatus(String(wp.transactionId ?? reference));
      if (st.status === "success") {
        const { data: updated } = await db.from("payment_intents").update({ status: "success", webhook_payload: { ...wp, check: st.raw } })
          .eq("id", intent.id).eq("status", "pending").select("id").maybeSingle();
        if (updated) await createPaidStoreOrder(db, reference, wp);
        return json({ ok: true, status: "success" });
      }
      if (st.status === "failed") {
        await db.from("payment_intents").update({ status: "failed" }).eq("id", intent.id);
        return json({ ok: true, status: "failed" });
      }
      return json({ ok: true, status: "pending" });
    }


    // Everything else needs auth
    const user = await requireUser(req);
    if (!user) return json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const DATA_ORDER_ACTIONS = new Set(["buy-data", "buy-data-momo-initiate", "bulk-buy-data", "bulk-buy-mixed"]);
    if (DATA_ORDER_ACTIONS.has(action)) {
      const access = await ensureUserOrderTypeAllowed(db, user.userId, "data");
      if (!access.ok) return json({ ok: false, error: access.error }, { status: 403 });
    }
    if (action === "smm-create-order") {
      const access = await ensureUserOrderTypeAllowed(db, user.userId, "smm");
      if (!access.ok) return json({ ok: false, error: access.error }, { status: 403 });
    }

    // ---------- READS ----------
    if (action === "get-profile") {
      const [p, w] = await Promise.all([
        db.from("profiles").select("*").eq("id", user.userId).maybeSingle(),
        db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle(),
      ]);
      const profile = p.data
        ? { ...p.data, referral_code: p.data.referral_active ? p.data.referral_code : null }
        : null;
      return json({ ok: true, profile, balance: Number(w.data?.balance ?? 0) });
    }

    if (action === "get-ban-status") {
      const { data } = await db.from("profiles").select("is_banned").eq("id", user.userId).maybeSingle();
      return json({ ok: true, banned: !!data?.is_banned });
    }

    if (action === "get-transactions") {
      const { data } = await db.from("transactions").select("*")
        .eq("user_id", user.userId).order("created_at", { ascending: false }).limit(200);
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "get-orders") {
      const { data } = await db.from("orders").select("*")
        .eq("user_id", user.userId).order("created_at", { ascending: false }).limit(200);
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "get-dashboard") {
      const [p, w, orders, tx, allOrders, refs, spent, smm] = await Promise.all([
        db.from("profiles").select("username,full_name,referral_active,referral_code").eq("id", user.userId).maybeSingle(),
        db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle(),
        db.from("orders").select("id,status,amount_charged,created_at,plan_name,network,phone").eq("user_id", user.userId).order("created_at", { ascending: false }).limit(5),
        db.from("transactions").select("id,type,amount,created_at,description").eq("user_id", user.userId).order("created_at", { ascending: false }).limit(5),
        db.from("orders").select("amount_charged,status", { count: "exact" }).eq("user_id", user.userId),
        db.from("referrals").select("id", { count: "exact", head: true }).eq("referrer_id", user.userId),
        db.from("transactions").select("amount").eq("user_id", user.userId).lt("amount", 0),
        db.from("smm_orders").select("status", { count: "exact" }).eq("user_id", user.userId),
      ]);
      const totalSpent = (spent.data ?? []).reduce((s: number, t: any) => s + Math.abs(Number(t.amount || 0)), 0);
      const isSuccess = (st: any) => {
        const s = String(st ?? "").toLowerCase();
        return s === "success" || s === "completed" || s === "complete" || s === "partial";
      };
      const successCount =
        (allOrders.data ?? []).filter((o: any) => isSuccess(o.status)).length +
        (smm.data ?? []).filter((o: any) => isSuccess(o.status)).length;
      const totalOrders = (allOrders.count ?? 0) + (smm.count ?? 0);
      return json({
        ok: true,
        profile: p.data, balance: Number(w.data?.balance ?? 0),
        recentOrders: orders.data ?? [], recentTx: tx.data ?? [],
        totalOrders, successOrders: successCount,
        totalSpent, totalReferrals: refs.count ?? 0,
      });
    }

    if (action === "ref-stats") {
      const [prof, wallet, refs, txs, fee] = await Promise.all([
        db.from("profiles").select("referral_code,referral_active").eq("id", user.userId).maybeSingle(),
        db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle(),
        db.from("referrals").select("id,referred_id,earned_total,created_at").eq("referrer_id", user.userId).order("created_at", { ascending: false }),
        db.from("transactions").select("amount").eq("user_id", user.userId).eq("type", "referral"),
        db.from("site_settings").select("value").eq("key", "referral_activation_fee").maybeSingle(),
      ]);
      const totalEarned = (txs.data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const active = !!prof.data?.referral_active;
      return json({
        ok: true,
        code: active ? (prof.data?.referral_code ?? "") : "",
        active,
        activationFee: Number(fee.data?.value ?? 50),
        walletBalance: Number(wallet.data?.balance ?? 0),
        referred: refs.data ?? [],
        totalEarned,
      });
    }

    if (action === "list-withdrawals") {
      const [rows, refEarn, refWd, minRow] = await Promise.all([
        db.from("withdrawals").select("*").eq("user_id", user.userId).order("created_at", { ascending: false }),
        db.from("transactions").select("amount").eq("user_id", user.userId).eq("type", "referral"),
        db.from("withdrawals").select("amount,status").eq("user_id", user.userId).in("status", ["pending", "approved", "paid"]),
        db.from("site_settings").select("value").eq("key", "withdrawal_minimum").maybeSingle(),
      ]);
      const earned = (refEarn.data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const wd = (refWd.data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      return json({
        ok: true, rows: rows.data ?? [],
        available: Math.max(0, Math.round((earned - wd) * 100) / 100),
        minimum: Number(minRow.data?.value ?? 100),
      });
    }

    // ---------- WRITES ----------
    if (action === "topup-request-otp") {
      const amount = Number(body.amount);
      const network = String(body.network || "MTN").toUpperCase();
      const phone = normalizeGhanaPhone(String(body.phone || ""));
      if (!Number.isFinite(amount) || amount < 1 || amount > 100000) return json({ ok: false, error: "Invalid amount" });
      if (!phone) return json({ ok: false, error: "Invalid Ghana phone. Use 0XXXXXXXXX" });
      if (!["MTN", "TELECEL", "AIRTELTIGO"].includes(network)) return json({ ok: false, error: "Invalid network" });
      // No email verification for top-ups.
      return json({ ok: true, challenge_id: "", skipped: true });
    }

    if (action === "topup-initiate") {
      const amount = Number(body.amount);
      const network = String(body.network || "MTN").toUpperCase();
      const phone = normalizeGhanaPhone(String(body.phone || ""));
      if (!Number.isFinite(amount) || amount < 1 || amount > 100000) return json({ ok: false, error: "Invalid amount" });
      if (!phone) return json({ ok: false, error: "Invalid Ghana phone. Use 0XXXXXXXXX" });
      if (!["MTN", "TELECEL", "AIRTELTIGO"].includes(network)) return json({ ok: false, error: "Invalid network" });
      // No email OTP for payments.

      const fee = feeFor(amount);
      const gross = Math.round((amount + fee) * 100) / 100; // what the user actually pays
      const reference = `TU${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
      const { data: intent, error } = await db.from("payment_intents").insert({
        user_id: user.userId, provider: gatewayName(), reference,
        amount: gross, fee, net_amount: amount, status: "pending",
      }).select("id,reference").single();
      if (error || !intent) return json({ ok: false, error: "Could not create intent" });
      try {
        const r = await initiateCheckout({ amount: gross, reference, phone, network: network as any });
        await db.from("payment_intents").update({
          webhook_payload: { initiate: r.raw, transactionId: r.transactionId, phone, network, credit: amount },
        }).eq("id", intent.id);
        return json({ ok: true, reference, transactionId: r.transactionId, phone, network });
      } catch (e: any) {
        await db.from("payment_intents").update({ status: "failed", webhook_payload: { error: String(e?.message || e) } }).eq("id", intent.id);
        return json({ ok: false, error: String(e?.message || e) });
      }
    }

    if (action === "topup-verify" || action === "topup-status") {
      const reference = String(body.reference || "");
      const { data: intent } = await db.from("payment_intents").select("*").eq("reference", reference).eq("user_id", user.userId).maybeSingle();
      if (!intent) return json({ ok: false, status: "not_found", error: "Not found" });
      if (intent.status === "success" || intent.status === "completed") return json({ ok: true, status: "success", credited: false });
      if (intent.status === "failed") return json({ ok: true, status: "failed", credited: false });
      const txId = (intent.webhook_payload as any)?.transactionId ?? intent.reference;
      const st = await checkStatus(String(txId));
      if (st.status === "success") {
        const { data: updated } = await db.from("payment_intents").update({
          status: "success",
          webhook_payload: { ...(intent.webhook_payload as any), check: st.raw },
        }).eq("id", intent.id).eq("status", "pending").select("id").maybeSingle();
        if (!updated) return json({ ok: true, status: "success", credited: false });
        const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
        const newBal = Math.round((Number(wallet?.balance ?? 0) + Number(intent.net_amount)) * 100) / 100;
        await db.from("wallets").update({ balance: newBal }).eq("user_id", user.userId);
        await db.from("transactions").insert({
          user_id: user.userId, type: "topup", amount: Number(intent.net_amount), balance_after: newBal,
          reference: intent.reference, description: `Wallet top-up`,
          meta: { paid: Number(intent.amount), fee: Number(intent.fee), credited: Number(intent.net_amount) },
        });
        return json({ ok: true, status: "success", credited: true });
      }
      if (st.status === "failed") {
        await db.from("payment_intents").update({ status: "failed", webhook_payload: { ...(intent.webhook_payload as any), check: st.raw } }).eq("id", intent.id);
        return json({ ok: true, status: "failed", credited: false });
      }
      return json({ ok: true, status: "pending", credited: false });
    }

    if (action === "buy-data") {
      const plan_id = String(body.plan_id || "");
      const phone = normalizeOrderPhone(String(body.phone || ""));
      const payMethod = String(body.payment_method || "wallet"); // "wallet" | "credit"
      if (!plan_id || !phone) return json({ ok: false, error: "Missing fields" });
      {
        const busy = await phonesWithActiveOrders(db, [phone]);
        if (busy.length) return json({ ok: false, error: `${phone} has an unfinished order. Please wait until it is completed.` });
      }
      const { data: plan } = await db.from("data_plans").select("*").eq("id", plan_id).maybeSingle();
      if (!plan || plan.active === false) return json({ ok: false, error: "Plan unavailable" });
      const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
      const balance = Number(wallet?.balance ?? 0);
      const agentRole = await isAgentUser(db, user.userId);
      const price = planPriceFor(plan, agentRole);

      let useCredit = false;
      let creditRow: any = null;
      if (payMethod === "credit") {
        if (!agentRole) return json({ ok: false, error: "Credit is only for agents" });
        creditRow = await getAgentCreditRow(db, user.userId);
        if (!creditRow?.enabled) return json({ ok: false, error: "Credit account not enabled" });
        const nextOut = Number(creditRow.outstanding ?? 0) + price;
        if (Number(creditRow.credit_limit ?? 0) > 0 && nextOut > Number(creditRow.credit_limit)) {
          return json({ ok: false, error: `Credit limit reached (GHS ${Number(creditRow.credit_limit).toFixed(2)})` });
        }
        useCredit = true;
      } else if (balance < price) {
        return json({ ok: false, error: "Insufficient wallet balance" });
      }
      const reference = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { data: order, error: oErr } = await db.from("orders").insert({
        user_id: user.userId, network: plan.network,
        plan_id: plan.id, plan_code: plan.plan_code, plan_name: plan.name,
        phone, amount_charged: price, api_cost: Number(plan.api_price),
        status: "pending", api_reference: reference,
      }).select().single();
      if (oErr || !order) return json({ ok: false, error: "Failed to create order" });
      const manualMode = await isDataManualMode(db);
      try {
        let apiRes: any = null;
        let apiStatus = "pending";
        let providerOutOfFunds = false;
        if (!manualMode) {
          try {
            apiRes = await primeCreateOrder({ package_id: plan.plan_code, phone, reference });
            apiStatus = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
            const success = apiRes?.success === true || ["success", "completed", "pending", "processing"].includes(apiStatus);
            if (!success) throw new Error(apiRes?.error ?? apiRes?.message ?? "API returned failure");
          } catch (apiErr: any) {
            const { isProviderInsufficient } = await import("../_shared/cheapdata.ts");
            if (!isProviderInsufficient(apiErr)) throw apiErr;
            // Our own data provider wallet is empty: keep the order queued so the
            // admin can retry it after topping up, and keep the user on "pending".
            providerOutOfFunds = true;
            apiStatus = "pending";
            apiRes = { api_insufficient: true, error: String(apiErr?.message || apiErr).slice(0, 300) };
          }
        }


        let finalBal: number | null = null;
        if (useCredit) {
          await addToCreditOutstanding(db, user.userId, price);
          await db.from("credit_orders_log").insert({
            agent_id: user.userId, order_type: "data", order_id: order.id, amount: price,
          });
          await db.from("transactions").insert({
            user_id: user.userId, type: "credit_purchase", amount: -price, balance_after: null,
            reference, description: `${plan.network} · ${plan.name} · ${phone} (credit)`,
            meta: { order_id: order.id, plan_code: plan.plan_code, paid_via: "credit" },
          });
        } else {
          const { data: debited, error: dErr } = await db.from("wallets")
            .update({ balance: Math.round((balance - price) * 100) / 100 })
            .eq("user_id", user.userId).eq("balance", balance)
            .select().maybeSingle();
          finalBal = debited ? Number(debited.balance) : NaN;
          if (dErr || !debited) {
            const { data: w2 } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
            const b2 = Number(w2?.balance ?? 0);
            if (b2 < price) throw new Error("Balance changed, insufficient funds");
            finalBal = Math.round((b2 - price) * 100) / 100;
            const { error: e2 } = await db.from("wallets").update({ balance: finalBal }).eq("user_id", user.userId).eq("balance", b2);
            if (e2) throw new Error("Wallet debit failed");
          }
          await db.from("transactions").insert({
            user_id: user.userId, type: "purchase", amount: -price, balance_after: finalBal,
            reference, description: `${plan.network} · ${plan.name} · ${phone}`,
            meta: { order_id: order.id, plan_code: plan.plan_code },
          });
        }
        await db.from("orders").update({
          status: (manualMode || providerOutOfFunds)
            ? "pending"
            : (["completed", "success"].includes(apiStatus) ? "completed" : "processing"),
          api_response: apiRes ?? { manual: true },
        }).eq("id", order.id);

        return json({ ok: true, orderId: order.id });
      } catch (e: any) {
        await db.from("orders").delete().eq("id", order.id);
        return json({ ok: false, error: String(e?.message || e) });
      }
    }


    // === MoMo direct pay for data (no wallet top-up first) ===
    if (action === "buy-data-momo-request-otp" || action === "agent-credit-pay-request-otp") {
      // No email verification for payments.
      return json({ ok: true, challenge_id: "", skipped: true });
    }

    // Payments no longer require an email OTP; kept for backwards compatibility.
    async function consumeOtp(_challenge_id: string, _otp: string): Promise<{ ok: true } | { ok: false; error: string }> {
      return { ok: true };
    }

    if (action === "buy-data-momo-initiate") {
      const plan_id = String(body.plan_id || "");
      const recipient = normalizeOrderPhone(String(body.phone || ""));
      const payer = normalizeGhanaPhone(String(body.payer || ""));
      const payNetwork = String(body.pay_network || "MTN").toUpperCase();
      const challenge_id = String(body.challenge_id || "");
      const otp = String(body.otp || "").trim();
      if (!plan_id || !recipient || !payer) return json({ ok: false, error: "Missing fields" });
      if (!["MTN", "TELECEL", "AIRTELTIGO"].includes(payNetwork)) return json({ ok: false, error: "Invalid pay network" });
      const otpCheck = await consumeOtp(challenge_id, otp);
      if (!otpCheck.ok) return json({ ok: false, error: otpCheck.error });
      {
        const busy = await phonesWithActiveOrders(db, [recipient]);
        if (busy.length) return json({ ok: false, error: `${recipient} has an unfinished order. Please wait until it is completed.` });
      }
      const { data: plan } = await db.from("data_plans").select("*").eq("id", plan_id).maybeSingle();
      if (!plan || plan.active === false) return json({ ok: false, error: "Plan unavailable" });
      const agentRoleD = await isAgentUser(db, user.userId);
      const price = planPriceFor(plan, agentRoleD);
      const fee = feeFor(price);
      const gross = Math.round((price + fee) * 100) / 100;
      const reference = `ORDM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // No order row yet — the order is only created once payment succeeds.
      const wpBase = { kind: "buy-data-momo", plan_id, recipient, payer, payNetwork, price };
      const { error: pErr } = await db.from("payment_intents").insert({
        user_id: user.userId, provider: gatewayName(), reference,
        amount: gross, fee, net_amount: price, status: "pending",
        webhook_payload: wpBase,
      });
      if (pErr) return json({ ok: false, error: pErr.message });
      try {
        const r = await initiateCheckout({ amount: gross, reference, phone: payer, network: payNetwork as any });
        await db.from("payment_intents").update({ webhook_payload: { ...wpBase, transactionId: r.transactionId } }).eq("reference", reference);
        return json({ ok: true, reference });
      } catch (e: any) {
        await db.from("payment_intents").update({ status: "failed", webhook_payload: { ...wpBase, error: String(e?.message || e) } }).eq("reference", reference);
        return json({ ok: false, error: String(e?.message || e) });
      }
    }


    if (action === "buy-data-momo-verify") {
      const reference = String(body.reference || "");
      const { data: intent } = await db.from("payment_intents").select("*").eq("reference", reference).eq("user_id", user.userId).maybeSingle();
      if (!intent) return json({ ok: false, status: "not_found" });
      const wp = (intent.webhook_payload ?? {}) as any;
      if (intent.status === "success") return json({ ok: true, status: "success" });
      if (intent.status === "failed") return json({ ok: true, status: "failed" });
      const txId = wp.transactionId ?? intent.reference;
      const st = await checkStatus(String(txId));
      if (st.status === "success") {
        const { data: updated } = await db.from("payment_intents").update({ status: "success", webhook_payload: { ...wp, check: st.raw } }).eq("id", intent.id).eq("status", "pending").select("id").maybeSingle();
        if (!updated) return json({ ok: true, status: "success" });
        await createPaidMomoOrder(db, intent, wp);
        return json({ ok: true, status: "success" });
      }
      if (st.status === "failed") {
        await db.from("payment_intents").update({ status: "failed" }).eq("id", intent.id);
        return json({ ok: true, status: "failed" });
      }
      return json({ ok: true, status: "pending" });
    }


    if (action === "bulk-buy-data") {
      const plan_id = String(body.plan_id || "");
      const rawPhones: string[] = Array.isArray(body.phones) ? body.phones : [];
      const phones = rawPhones.map((p: any) => normalizeOrderPhone(String(p || ""))).filter(Boolean) as string[];
      if (!plan_id || phones.length === 0) return json({ ok: false, error: "Missing fields" });
      if (phones.length > 50) return json({ ok: false, error: "Max 50 numbers per bulk order" });
      {
        const seen = new Set<string>();
        const dups: string[] = [];
        for (const p of phones) { if (seen.has(p)) dups.push(p); else seen.add(p); }
        if (dups.length) return json({ ok: false, error: `Duplicate number(s) in submission: ${Array.from(new Set(dups)).join(", ")}` });
        const busy = await phonesWithActiveOrders(db, phones);
        if (busy.length) return json({ ok: false, error: `These numbers have unfinished orders: ${busy.join(", ")}` });
      }
      const { data: plan } = await db.from("data_plans").select("*").eq("id", plan_id).maybeSingle();
      if (!plan || plan.active === false) return json({ ok: false, error: "Plan unavailable" });
      const agentRoleB = await isAgentUser(db, user.userId);
      const price = planPriceFor(plan, agentRoleB);
      const total = Math.round(price * phones.length * 100) / 100;
      const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
      const balance = Number(wallet?.balance ?? 0);
      if (balance < total) return json({ ok: false, error: `Insufficient balance. Need GHS ${total.toFixed(2)}` });

      const manualMode = await isDataManualMode(db);
      const results: { phone: string; ok: boolean; error?: string; orderId?: string }[] = [];
      let succeeded = 0;
      const batchId = phones.length > 1 ? crypto.randomUUID() : null;

      for (const phone of phones) {
        const reference = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { data: order, error: oErr } = await db.from("orders").insert({
          user_id: user.userId, network: plan.network,
          plan_id: plan.id, plan_code: plan.plan_code, plan_name: plan.name,
          phone, amount_charged: price, api_cost: Number(plan.api_price),
          status: "pending", api_reference: reference, batch_id: batchId,
        }).select().single();
        if (oErr || !order) { results.push({ phone, ok: false, error: "Failed to create order" }); continue; }
        try {
          let apiRes: any = null;
          let apiStatus = "pending";
          if (!manualMode) {
            apiRes = await primeCreateOrder({ package_id: plan.plan_code, phone, reference });
            apiStatus = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
            const success = apiRes?.success === true || ["success", "completed", "pending", "processing"].includes(apiStatus);
            if (!success) throw new Error(apiRes?.error ?? apiRes?.message ?? "API returned failure");
          }
          const { data: w2 } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
          const b2 = Number(w2?.balance ?? 0);
          if (b2 < price) throw new Error("Balance changed, insufficient funds");
          const finalBal = Math.round((b2 - price) * 100) / 100;
          const { error: e2 } = await db.from("wallets").update({ balance: finalBal }).eq("user_id", user.userId).eq("balance", b2);
          if (e2) throw new Error("Wallet debit failed");
          await db.from("transactions").insert({
            user_id: user.userId, type: "purchase", amount: -price, balance_after: finalBal,
            reference, description: `${plan.network} · ${plan.name} · ${phone} (bulk)`,
            meta: { order_id: order.id, plan_code: plan.plan_code, bulk: true },
          });
          await db.from("orders").update({
            status: manualMode ? "pending" : (["completed", "success"].includes(apiStatus) ? "completed" : "processing"),
            api_response: apiRes ?? { manual: true },
          }).eq("id", order.id);

          succeeded++;
          results.push({ phone, ok: true, orderId: order.id });
        } catch (e: any) {
          await db.from("orders").delete().eq("id", order.id);
          results.push({ phone, ok: false, error: String(e?.message || e) });
        }
      }
      return json({ ok: true, total: phones.length, succeeded, failed: phones.length - succeeded, results });
    }

    if (action === "bulk-buy-mixed") {
      const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
      const items: { phone: string; plan_id: string }[] = rawItems
        .map((it) => ({ phone: normalizeOrderPhone(String(it?.phone || "")), plan_id: String(it?.plan_id || "") }))
        .filter((it): it is { phone: string; plan_id: string } => !!it.phone && !!it.plan_id);
      if (items.length === 0) return json({ ok: false, error: "No valid orders" });
      if (items.length > 100) return json({ ok: false, error: "Max 100 orders per bulk" });
      {
        const seen = new Set<string>();
        const dups: string[] = [];
        for (const it of items) { if (seen.has(it.phone)) dups.push(it.phone); else seen.add(it.phone); }
        if (dups.length) return json({ ok: false, error: `Duplicate number(s) in submission: ${Array.from(new Set(dups)).join(", ")}` });
        const busy = await phonesWithActiveOrders(db, items.map((it) => it.phone));
        if (busy.length) return json({ ok: false, error: `These numbers have unfinished orders: ${busy.join(", ")}` });
      }
      const planIds = Array.from(new Set(items.map((i) => i.plan_id)));
      const { data: plansData } = await db.from("data_plans").select("*").in("id", planIds);
      const planMap = new Map<string, any>((plansData ?? []).map((p: any) => [p.id, p]));
      for (const it of items) {
        const p = planMap.get(it.plan_id);
        if (!p || p.active === false) return json({ ok: false, error: `Plan unavailable for ${it.phone}` });
      }
      const agentRoleM = await isAgentUser(db, user.userId);
      const total = Math.round(items.reduce((s, it) => s + planPriceFor(planMap.get(it.plan_id)!, agentRoleM), 0) * 100) / 100;
      const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
      const balance = Number(wallet?.balance ?? 0);
      if (balance < total) return json({ ok: false, error: `Insufficient balance. Need GHS ${total.toFixed(2)}` });

      const manualMode = await isDataManualMode(db);
      const results: { phone: string; plan_id: string; ok: boolean; error?: string; orderId?: string }[] = [];
      let succeeded = 0;
      const batchId = items.length > 1 ? crypto.randomUUID() : null;

      for (const it of items) {
        const plan = planMap.get(it.plan_id)!;
        const price = planPriceFor(plan, agentRoleM);
        const reference = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { data: order, error: oErr } = await db.from("orders").insert({
          user_id: user.userId, network: plan.network,
          plan_id: plan.id, plan_code: plan.plan_code, plan_name: plan.name,
          phone: it.phone, amount_charged: price, api_cost: Number(plan.api_price),
          status: "pending", api_reference: reference, batch_id: batchId,
        }).select().single();
        if (oErr || !order) { results.push({ phone: it.phone, plan_id: it.plan_id, ok: false, error: "Failed to create order" }); continue; }
        try {
          let apiRes: any = null;
          let apiStatus = "pending";
          if (!manualMode) {
            apiRes = await primeCreateOrder({ package_id: plan.plan_code, phone: it.phone, reference });
            apiStatus = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
            const success = apiRes?.success === true || ["success", "completed", "pending", "processing"].includes(apiStatus);
            if (!success) throw new Error(apiRes?.error ?? apiRes?.message ?? "API returned failure");
          }
          const { data: w2 } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
          const b2 = Number(w2?.balance ?? 0);
          if (b2 < price) throw new Error("Balance changed, insufficient funds");
          const finalBal = Math.round((b2 - price) * 100) / 100;
          const { error: e2 } = await db.from("wallets").update({ balance: finalBal }).eq("user_id", user.userId).eq("balance", b2);
          if (e2) throw new Error("Wallet debit failed");
          await db.from("transactions").insert({
            user_id: user.userId, type: "purchase", amount: -price, balance_after: finalBal,
            reference, description: `${plan.network} · ${plan.name} · ${it.phone} (bulk)`,
            meta: { order_id: order.id, plan_code: plan.plan_code, bulk: true, mixed: true },
          });
          await db.from("orders").update({
            status: manualMode ? "pending" : (["completed", "success"].includes(apiStatus) ? "completed" : "processing"),
            api_response: apiRes ?? { manual: true },
          }).eq("id", order.id);

          succeeded++;
          results.push({ phone: it.phone, plan_id: it.plan_id, ok: true, orderId: order.id });
        } catch (e: any) {
          await db.from("orders").delete().eq("id", order.id);
          results.push({ phone: it.phone, plan_id: it.plan_id, ok: false, error: String(e?.message || e) });
        }
      }
      return json({ ok: true, total: items.length, succeeded, failed: items.length - succeeded, results });
    }


    if (action === "sync-orders") {
      const { data: pending } = await db.from("orders").select("*")
        .eq("user_id", user.userId)
        .in("status", ["pending", "processing"])
        .order("created_at", { ascending: false }).limit(100);
      let updated = 0;
      for (const o of pending ?? []) {
        const r0 = o?.api_response ?? {};
        const apiId = r0?.data?.order?.id ?? r0?.data?.order?.order_id ?? r0?.data?.id ?? r0?.data?.order_id ?? r0?.order_id ?? r0?.id ?? null;
        if (!apiId) continue;
        try {
          const res: any = await primeOrderStatus(String(apiId));
          const raw = String(res?.data?.order?.status ?? res?.data?.status ?? res?.status ?? "").toLowerCase();
          let next: string | null = null;
          if (["success", "successful", "completed", "delivered"].includes(raw)) next = "completed";
          else if (["refunded", "refund", "reversed", "cancelled", "canceled", "rejected"].includes(raw)) next = "refunded";
          else if (["failed", "error", "declined"].includes(raw)) next = "failed";
          else if (["processing", "in_progress", "in progress", "sent"].includes(raw)) next = "processing";
          else if (["pending", "queued", "waiting"].includes(raw)) next = "pending";
          if (!next || next === o.status) continue;
          const needsRefund = (next === "failed" || next === "refunded") && !["failed", "refunded"].includes(String(o.status));
          await db.from("orders").update({ status: next === "failed" ? "failed" : next, api_response: res }).eq("id", o.id);
          updated++;
          if (needsRefund) {
            await refundOrder(db, o);
            await db.from("orders").update({ status: "refunded" }).eq("id", o.id);
          }

        } catch { /* continue */ }
      }
      return json({ ok: true, checked: pending?.length ?? 0, updated });
    }

    if (action === "activate-referral") {
      const { data: profile } = await db.from("profiles")
        .select("id,referral_active,referred_by").eq("id", user.userId).maybeSingle();
      if (!profile) return json({ ok: false, error: "Profile not found" });
      const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
      const cur = Number(wallet?.balance ?? 0);
      if (profile.referral_active) return json({ ok: true, alreadyActive: true, balance: cur });
      const { data: activated, error: aErr } = await db.from("profiles")
        .update({ referral_active: true }).eq("id", user.userId)
        .or("referral_active.eq.false,referral_active.is.null")
        .select("id,referred_by").maybeSingle();
      if (aErr) return json({ ok: false, error: "Could not activate" });
      if (!activated) return json({ ok: true, alreadyActive: true, balance: cur });
      if (activated.referred_by) {
        const { data: rew } = await db.from("site_settings").select("value").eq("key", "referral_reward_per_signup").maybeSingle();
        const reward = Number(rew?.value ?? 10);
        const { data: rw } = await db.from("wallets").select("balance").eq("user_id", activated.referred_by).maybeSingle();
        const rb = Math.round((Number(rw?.balance ?? 0) + reward) * 100) / 100;
        await db.from("wallets").update({ balance: rb }).eq("user_id", activated.referred_by);
        await db.from("transactions").insert({
          user_id: activated.referred_by, type: "referral", amount: reward, balance_after: rb,
          description: "Referral reward",
          meta: { referred_id: activated.id },
        });
        await db.from("referrals").update({ earned_total: reward }).eq("referred_id", activated.id);
      }
      return json({ ok: true, alreadyActive: false, balance: cur });
    }

    if (action === "create-withdrawal") {
      const amount = Number(body.amount);
      const method = String(body.method || "momo");
      const details = body.details || {};
      if (!Number.isFinite(amount) || amount <= 0) return json({ ok: false, error: "Invalid amount" });
      if (!["momo", "bank"].includes(method)) return json({ ok: false, error: "Invalid method" });
      if (!details.account_name || !details.account_number || !details.network_or_bank) {
        return json({ ok: false, error: "Missing withdrawal details" });
      }
      const [refEarn, refWd, minRow] = await Promise.all([
        db.from("transactions").select("amount").eq("user_id", user.userId).eq("type", "referral"),
        db.from("withdrawals").select("amount,status").eq("user_id", user.userId).in("status", ["pending", "approved", "paid"]),
        db.from("site_settings").select("value").eq("key", "withdrawal_minimum").maybeSingle(),
      ]);
      const earned = (refEarn.data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const wd = (refWd.data ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const available = earned - wd;
      const minimum = Number(minRow.data?.value ?? 100);
      if (available < minimum) return json({ ok: false, error: `Minimum referral balance for withdrawal is GHS ${minimum.toFixed(2)}` });
      if (amount < minimum) return json({ ok: false, error: `Minimum withdrawal is GHS ${minimum.toFixed(2)}` });
      if (amount > available) return json({ ok: false, error: `Only GHS ${available.toFixed(2)} available` });
      const { error } = await db.from("withdrawals").insert({
        user_id: user.userId, amount, method, details, status: "pending",
      });
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true });
    }

    // ================= AGENT =================
    if (action === "agent-status") {
      const [ag, s1, s2, wal] = await Promise.all([
        db.from("agents").select("*").eq("user_id", user.userId).eq("active", true).maybeSingle(),
        db.from("site_settings").select("value").eq("key", "agent_activation_fee").maybeSingle(),
        db.from("site_settings").select("value").eq("key", "agent_withdrawal_min").maybeSingle(),
        db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle(),
      ]);
      return json({
        ok: true,
        agent: ag.data,
        activationFee: Number(s1.data?.value ?? 100),
        withdrawalMin: Number(s2.data?.value ?? 150),
        walletBalance: Number(wal.data?.balance ?? 0),
      });
    }

    if (action === "agent-activate") {
      const { data: existing } = await db.from("agents").select("user_id,active").eq("user_id", user.userId).maybeSingle();
      if (existing && existing.active) return json({ ok: true, alreadyActive: true });
      const { data: sf } = await db.from("site_settings").select("value").eq("key", "agent_activation_fee").maybeSingle();
      const fee = Number(sf?.value ?? 100);
      const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
      const bal = Number(wallet?.balance ?? 0);
      if (bal < fee) return json({ ok: false, error: `Insufficient wallet balance. Need GHS ${fee.toFixed(2)}` });
      const newBal = Math.round((bal - fee) * 100) / 100;
      const { data: debited } = await db.from("wallets").update({ balance: newBal }).eq("user_id", user.userId).eq("balance", bal).select("balance").maybeSingle();
      if (!debited) return json({ ok: false, error: "Balance changed, please try again" });
      await db.from("transactions").insert({
        user_id: user.userId, type: "agent_activation", amount: -fee, balance_after: newBal,
        description: "Agent activation fee",
      });
      const { error: aErr } = existing
        ? await db.from("agents").update({ active: true, activated_at: new Date().toISOString() }).eq("user_id", user.userId)
        : await db.from("agents").insert({ user_id: user.userId });
      if (aErr) {
        await db.from("wallets").update({ balance: bal }).eq("user_id", user.userId);
        return json({ ok: false, error: aErr.message });
      }
      return json({ ok: true, balance: newBal });
    }

    if (action === "agent-update-settings") {
      const storeRaw = body.store_name !== undefined ? String(body.store_name ?? "").trim().toLowerCase() : undefined;
      const wa = body.whatsapp_link !== undefined ? String(body.whatsapp_link ?? "").trim() : undefined;
      const cn = body.contact_number !== undefined ? String(body.contact_number ?? "").trim() : undefined;
      const patch: any = {};
      if (storeRaw !== undefined) {
        if (storeRaw && !/^[a-z0-9][a-z0-9-]{2,30}$/.test(storeRaw)) return json({ ok: false, error: "Store name: 3-31 chars, letters/numbers/hyphen, must start with letter or number" });
        patch.store_name = storeRaw || null;
      }
      if (wa !== undefined) patch.whatsapp_link = wa || null;
      if (cn !== undefined) patch.contact_number = cn || null;
      const hhmm = (v: any) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
      if (body.store_open_time !== undefined) {
        if (!hhmm(body.store_open_time)) return json({ ok: false, error: "Invalid opening time" });
        patch.store_open_time = String(body.store_open_time);
      }
      if (body.store_close_time !== undefined) {
        if (!hhmm(body.store_close_time)) return json({ ok: false, error: "Invalid closing time" });
        patch.store_close_time = String(body.store_close_time);
      }
      if (body.store_hours_mode !== undefined) {
        const m = String(body.store_hours_mode);
        if (!["open", "auto", "closed"].includes(m)) return json({ ok: false, error: "Invalid store hours mode" });
        patch.store_hours_mode = m;
      }
      const { error } = await db.from("agents").update(patch).eq("user_id", user.userId);
      if (error) {
        if (String(error.message).toLowerCase().includes("store_name") || String(error.code) === "23505")
          return json({ ok: false, error: "Store name already taken" });
        return json({ ok: false, error: error.message });
      }
      return json({ ok: true });
    }

    if (action === "agent-list-plans") {
      const [plans, ov, ag] = await Promise.all([
        db.from("data_plans").select("id,network,plan_code,name,size,validity,custom_price,agent_price,active,sort_order").eq("active", true).order("network").order("sort_order"),
        db.from("agent_plans").select("plan_id,agent_price,markup_percent,active").eq("agent_id", user.userId),
        db.from("agents").select("global_markup_percent,auto_markup").eq("user_id", user.userId).maybeSingle(),
      ]);
      const ovMap = new Map<string, any>((ov.data ?? []).map((o: any) => [o.plan_id, o]));
      const gm = Number(ag.data?.global_markup_percent ?? 0);
      const rows = (plans.data ?? []).map((p: any) => {
        const o = ovMap.get(p.id);
        const base = p.agent_price != null ? Number(p.agent_price) : Number(p.custom_price);
        let effective = base + (base * gm) / 100;
        if (o) {
          if (o.agent_price != null) effective = Number(o.agent_price);
          else if (o.markup_percent != null) effective = base + (base * Number(o.markup_percent)) / 100;
        }
        return {
          id: p.id, network: p.network, plan_code: p.plan_code, name: p.name, size: p.size, validity: p.validity,
          base_price: base,
          agent_price: o?.agent_price ?? null,
          markup_percent: o?.markup_percent ?? null,
          effective_price: Math.round(effective * 100) / 100,
        };
      });
      return json({ ok: true, rows, globalMarkup: gm, autoMarkup: ag.data?.auto_markup ?? true });
    }

    if (action === "agent-set-plan") {
      const plan_id = String(body.plan_id || "");
      const ap = body.agent_price;
      const mp = body.markup_percent;
      const agent_price = ap === null || ap === undefined || ap === "" ? null : Number(ap);
      const markup_percent = mp === null || mp === undefined || mp === "" ? null : Number(mp);
      if (!plan_id) return json({ ok: false, error: "Missing plan" });
      const { error } = await db.from("agent_plans").upsert(
        { agent_id: user.userId, plan_id, agent_price, markup_percent, active: true },
        { onConflict: "agent_id,plan_id" }
      );
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true });
    }

    if (action === "agent-set-global-markup") {
      const markup = Number(body.markup_percent ?? 0);
      const auto = body.auto_markup !== false;
      if (!Number.isFinite(markup) || markup < 0 || markup > 500) return json({ ok: false, error: "Invalid markup" });
      await db.from("agents").update({ global_markup_percent: markup, auto_markup: auto }).eq("user_id", user.userId);
      if (body.apply_now === true) {
        await db.from("agent_plans").delete().eq("agent_id", user.userId);
      }
      return json({ ok: true });
    }

    if (action === "agent-list-orders") {
      const { data } = await db.from("agent_orders")
        .select("*, data_plans(name,network,size)")
        .eq("agent_id", user.userId).order("created_at", { ascending: false }).limit(200);
      const rows = (data ?? []) as any[];
      const orderIds = rows.map((r) => r.order_id).filter(Boolean);
      if (orderIds.length) {
        const { data: linked } = await db.from("orders").select("id,status").in("id", orderIds);
        const map = new Map<string, string>((linked ?? []).map((o: any) => [o.id, o.status]));
        for (const r of rows) {
          const live = r.order_id ? map.get(r.order_id) : null;
          if (live) r.order_status = (live === "refunded" || live === "failed") ? "delivery_failed" : live;
        }
      }
      return json({ ok: true, rows });
    }

    if (action === "agent-list-withdrawals") {
      const [rows, minRow, ag] = await Promise.all([
        db.from("agent_withdrawals").select("*").eq("agent_id", user.userId).order("created_at", { ascending: false }),
        db.from("site_settings").select("value").eq("key", "agent_withdrawal_min").maybeSingle(),
        db.from("agents").select("profit_balance").eq("user_id", user.userId).maybeSingle(),
      ]);
      return json({
        ok: true, rows: rows.data ?? [],
        minimum: Number(minRow.data?.value ?? 150),
        available: Number(ag.data?.profit_balance ?? 0),
      });
    }

    if (action === "agent-request-withdrawal") {
      const amount = Number(body.amount);
      const method = String(body.method || "momo");
      const details = body.details || {};
      if (!Number.isFinite(amount) || amount <= 0) return json({ ok: false, error: "Invalid amount" });
      if (!details.account_name || !details.account_number || !details.network_or_bank) return json({ ok: false, error: "Missing withdrawal details" });
      const [minRow, ag] = await Promise.all([
        db.from("site_settings").select("value").eq("key", "agent_withdrawal_min").maybeSingle(),
        db.from("agents").select("profit_balance").eq("user_id", user.userId).maybeSingle(),
      ]);
      const minimum = Number(minRow.data?.value ?? 150);
      const bal = Number(ag.data?.profit_balance ?? 0);
      if (bal < minimum) return json({ ok: false, error: `Minimum profit balance for withdrawal is GHS ${minimum.toFixed(2)}` });
      if (amount < minimum) return json({ ok: false, error: `Minimum withdrawal is GHS ${minimum.toFixed(2)}` });
      if (amount > bal) return json({ ok: false, error: `Only GHS ${bal.toFixed(2)} available` });
      const newBal = Math.round((bal - amount) * 100) / 100;
      const { data: updated } = await db.from("agents").update({ profit_balance: newBal }).eq("user_id", user.userId).eq("profit_balance", bal).select("profit_balance").maybeSingle();
      if (!updated) return json({ ok: false, error: "Balance changed, try again" });
      const { error } = await db.from("agent_withdrawals").insert({ agent_id: user.userId, amount, method, details, status: "pending" });
      if (error) {
        await db.from("agents").update({ profit_balance: bal }).eq("user_id", user.userId);
        return json({ ok: false, error: error.message });
      }
      return json({ ok: true, balance: newBal });
    }

    // ================= SMM (Social Media Boosting) =================
    if (action === "smm-list-services") {
      const cols = "id,service_id,provider,name,category,platform,min_quantity,max_quantity,base_price_per_1000,custom_price_per_1000,markup_percent,auto_markup";
      const requestedLimit = Math.floor(Number(body.limit ?? 1000));
      const pageSize = Math.min(Math.max(requestedLimit || 1000, 1), 1000);
      const requestedPage = Math.max(1, Math.floor(Number(body.page ?? 0)));
      const buildQuery = (from: number) => db.from("smm_services")
        .select(cols)
        .eq("active", true)
        .in("platform", [...ALLOWED_PLATFORMS])
        .order("platform").order("category").order("custom_price_per_1000").order("id")
        .range(from, from + pageSize - 1);
      if (Number.isFinite(Number(body.page)) && requestedPage > 0) {
        const from = (requestedPage - 1) * pageSize;
        const { data, error } = await buildQuery(from);
        if (error) throw error;
        return json({ ok: true, rows: data ?? [], page: requestedPage, limit: pageSize, hasMore: (data ?? []).length === pageSize });
      }
      const all: any[] = [];
      for (let from = 0; from < 100000; from += pageSize) {
        const { data, error } = await buildQuery(from);
        if (error) break;
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < pageSize) break;
      }
      return json({ ok: true, rows: all });
    }

    if (action === "smm-list-orders") {
      const pageSize = 1000;
      const rows: any[] = [];
      for (let from = 0; from < 100000; from += pageSize) {
        const { data, error } = await db.from("smm_orders").select("*")
          .eq("user_id", user.userId)
          .neq("status", "failed")
          .order("created_at", { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) break;
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < pageSize) break;
      }
      return json({ ok: true, rows });
    }


    if (action === "smm-create-order") {
      const smm_service_id = String(body.smm_service_id || "");
      const link = String(body.link || "").trim();
      const quantity = Math.floor(Number(body.quantity));
      if (!smm_service_id || !link || !Number.isFinite(quantity) || quantity <= 0)
        return json({ ok: false, error: "Missing fields" });
      const { data: svc } = await db.from("smm_services").select("*").eq("id", smm_service_id).maybeSingle();
      if (!svc || svc.active === false) return json({ ok: false, error: "Service unavailable" });
      if (quantity < svc.min_quantity || quantity > svc.max_quantity)
        return json({ ok: false, error: `Quantity must be between ${svc.min_quantity} and ${svc.max_quantity}` });

      const base = Number(svc.base_price_per_1000);
      const price1000 = Number(svc.custom_price_per_1000 ?? base);
      const cost = Math.round((base * quantity / 1000) * 10000) / 10000;
      const total = Math.round((price1000 * quantity / 1000) * 100) / 100;

      const { data: wallet } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
      const balance = Number(wallet?.balance ?? 0);
      if (balance < total) return json({ ok: false, error: `Insufficient balance. Need GHS ${total.toFixed(2)}` });

      const { data: order, error: oErr } = await db.from("smm_orders").insert({
        user_id: user.userId, smm_service_id: svc.id,
        service_id: svc.service_id, provider: svc.provider, service_name: svc.name, platform: svc.platform,
        link, quantity, amount_charged: total, cost_price: cost, profit: Math.round((total - cost) * 100) / 100,
        status: "pending",
      }).select().single();
      if (oErr || !order) return json({ ok: false, error: "Failed to create order" });

      const debitWallet = async (reference: string | null) => {
        const { data: w2 } = await db.from("wallets").select("balance").eq("user_id", user.userId).maybeSingle();
        const b2 = Number(w2?.balance ?? 0);
        if (b2 < total) throw new Error("Balance changed, insufficient funds");
        const finalBal = Math.round((b2 - total) * 100) / 100;
        const { error: e2 } = await db.from("wallets").update({ balance: finalBal }).eq("user_id", user.userId).eq("balance", b2);
        if (e2) throw new Error("Wallet debit failed");
        await db.from("transactions").insert({
          user_id: user.userId, type: "purchase", amount: -total, balance_after: finalBal,
          reference,
          description: `SMM · ${svc.platform} · ${svc.name} · qty ${quantity}`,
          meta: { smm_order_id: order.id, service_id: svc.service_id },
        });
      };

      try {
        let apiRes: any;
        try {
          apiRes = await smmPlaceOrder({ service_id: svc.service_id, provider: svc.provider, link, quantity });
        } catch (apiErr: any) {
          const { isProviderInsufficient } = await import("../_shared/netwave.ts");
          if (!isProviderInsufficient(apiErr)) throw apiErr;
          // Our boosting provider wallet is empty: queue the order (user stays on
          // "pending") so the admin can retry after topping up.
          await debitWallet(null);
          await db.from("smm_orders").update({
            status: "pending",
            raw: { api_insufficient: true, error: String(apiErr?.message || apiErr).slice(0, 300) },
          }).eq("id", order.id);
          return json({ ok: true, orderId: order.id, queued: true });
        }

        const providerOrderId = String(apiRes?.data?.order_id ?? apiRes?.order_id ?? apiRes?.data?.order?.id ?? "");
        const apiStatus = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "pending").toLowerCase();
        const errText = String(apiRes?.error ?? apiRes?.message ?? "").toLowerCase();

        // Provider wallet empty reported inside a 200 payload → queue it too.
        if (errText.includes("insufficient") || apiStatus.includes("insufficient")) {
          await debitWallet(null);
          await db.from("smm_orders").update({
            status: "pending",
            raw: { api_insufficient: true, response: apiRes },
          }).eq("id", order.id);
          return json({ ok: true, orderId: order.id, queued: true });
        }

        const failed =
          apiRes?.success === false ||
          !providerOrderId ||
          ["failed", "error", "rejected", "declined", "cancelled", "canceled", "refunded"].includes(apiStatus) ||
          (apiStatus.startsWith("api_") && apiStatus !== "api_pending");
        if (failed) {
          await db.from("smm_orders").update({ status: "failed", raw: apiRes }).eq("id", order.id);
          return json({ ok: false, error: "Order failed. Please try again later." });
        }

        // Debit wallet only after the provider accepted the order
        await debitWallet(providerOrderId || null);
        await db.from("smm_orders").update({
          provider_order_id: providerOrderId || null,
          status: ["completed", "success"].includes(apiStatus) ? "completed" : (["processing", "in progress"].includes(apiStatus) ? "processing" : "pending"),
          raw: apiRes,
        }).eq("id", order.id);
        return json({ ok: true, orderId: order.id });
      } catch (e: any) {
        const m = String(e?.message || e).toLowerCase();
        await db.from("smm_orders").update({ status: "failed", raw: { error: String(e?.message || e) } }).eq("id", order.id);
        if (m.includes("insufficient") || m.includes("balance") || m.includes("api_"))
          return json({ ok: false, error: "Order failed. Please try again later." });
        return json({ ok: false, error: String(e?.message || e) });
      }


    }

    if (action === "smm-sync-orders") {
      const { data: pending } = await db.from("smm_orders").select("*")
        .eq("user_id", user.userId).in("status", ["pending", "processing"])
        .order("created_at", { ascending: false }).limit(100);
      let updated = 0;
      for (const o of pending ?? []) {
        if (!o.provider_order_id) continue;
        try {
          const res: any = await smmOrderStatus(o.provider_order_id);
          const d = res?.data ?? res ?? {};
          const raw = String(d?.status ?? "").toLowerCase();
          let next: string | null = null;
          if (["completed", "success", "done"].includes(raw)) next = "completed";
          else if (["partial"].includes(raw)) next = "partial";
          else if (["refunded", "refund", "reversed", "cancelled", "canceled"].includes(raw)) next = "refunded";
          else if (
            ["failed", "error", "rejected", "declined"].includes(raw) ||
            raw.startsWith("api_") && raw !== "api_pending" ||
            raw.includes("insufficient")
          ) next = "refunded";
          else if (["processing", "in progress", "in_progress", "inprogress", "active"].includes(raw)) next = "processing";
          else if (["pending", "queued", "waiting", "api_pending"].includes(raw)) next = "pending";

          const startCount = d?.start_count ?? d?.startCount ?? null;
          const remainsRaw = d?.remains ?? d?.remaining ?? null;
          const patch: Record<string, unknown> = { raw: res };
          if (next && next !== o.status) patch.status = next;
          if (startCount != null && Number.isFinite(Number(startCount))) patch.start_count = Number(startCount);
          if (remainsRaw != null && Number.isFinite(Number(remainsRaw))) patch.remains = Number(remainsRaw);
          else if (next === "completed") patch.remains = 0;

          await db.from("smm_orders").update(patch).eq("id", o.id);
          if (next && next !== o.status) updated++;

          const needsRefund = (next === "failed" || next === "refunded") && !["failed", "refunded"].includes(String(o.status));
          if (needsRefund) {
            const { data: w } = await db.from("wallets").select("balance").eq("user_id", o.user_id).maybeSingle();
            const nb = Math.round((Number(w?.balance ?? 0) + Number(o.amount_charged)) * 100) / 100;
            await db.from("wallets").update({ balance: nb }).eq("user_id", o.user_id);
            await db.from("transactions").insert({
              user_id: o.user_id, type: "refund", amount: Number(o.amount_charged),
              balance_after: nb, reference: o.provider_order_id,
              description: `Refund SMM (${raw || "failed"}): ${o.service_name}`,
              meta: { smm_order_id: o.id, provider_status: raw },
            });
          }

        } catch { /* skip */ }
      }

      return json({ ok: true, checked: pending?.length ?? 0, updated });
    }

    // ============ BUSINESS HOURS (public) ============
    if (action === "business-status") {
      const s = await getBusinessSettings(db);
      const st = computeStatus(s);
      const pay = await getPaymentSettings(db);
      return json({ ok: true, ...st, reminderMinutes: s.reminderMinutes, payments: pay });
    }

    // ============ AGENT CREDIT ============
    if (action === "agent-credit-status") {
      const { data: ag } = await db.from("agents").select("user_id").eq("user_id", user.userId).maybeSingle();
      if (!ag) return json({ ok: true, isAgent: false, enabled: false, outstanding: 0, limit: 0, todayOrders: 0, todayAmount: 0, reminder: false, restricted: false });
      const settings = await getBusinessSettings(db);
      const st = computeStatus(settings);
      const cr = await getAgentCreditRow(db, user.userId);
      const enabled = !!cr?.enabled;
      const outstanding = Number(cr?.outstanding ?? 0);
      const limit = Number(cr?.credit_limit ?? 0);
      // Today's ledger (unsettled entries created today)
      const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
      const { data: today } = await db.from("credit_orders_log").select("amount")
        .eq("agent_id", user.userId).gte("created_at", startOfDay.toISOString());
      const todayOrders = (today ?? []).length;
      const todayAmount = Math.round((today ?? []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0) * 100) / 100;
      const reminder = enabled && outstanding > 0 && st.open && st.minutesToClose <= settings.reminderMinutes;
      const restricted = enabled && outstanding > 0 && !st.open;
      return json({
        ok: true, isAgent: true, enabled, outstanding, limit,
        todayOrders, todayAmount,
        open: st.open, closeTime: st.closeTime, minutesToClose: st.minutesToClose,
        reminderMinutes: settings.reminderMinutes,
        reminder, restricted,
      });
    }

    if (action === "agent-credit-log") {
      const { data } = await db.from("credit_orders_log").select("*")
        .eq("agent_id", user.userId).order("created_at", { ascending: false }).limit(200);
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "agent-credit-pay-initiate") {
      const cr = await getAgentCreditRow(db, user.userId);
      if (!cr?.enabled) return json({ ok: false, error: "Credit account not enabled" });
      const outstanding = Number(cr.outstanding ?? 0);
      if (outstanding <= 0) return json({ ok: false, error: "No outstanding balance to settle" });
      const payer = normalizeGhanaPhone(String(body.payer || ""));
      const payNetwork = String(body.pay_network || "MTN").toUpperCase();
      const challenge_id = String(body.challenge_id || "");
      const otp = String(body.otp || "").trim();
      if (!payer) return json({ ok: false, error: "Invalid payer phone" });
      if (!["MTN", "TELECEL", "AIRTELTIGO"].includes(payNetwork)) return json({ ok: false, error: "Invalid network" });
      const otpCheck = await consumeOtp(challenge_id, otp);
      if (!otpCheck.ok) return json({ ok: false, error: otpCheck.error });
      const reference = `CRDT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { error: pErr } = await db.from("payment_intents").insert({
        user_id: user.userId, provider: gatewayName(), reference,
        amount: outstanding, fee: 0, net_amount: outstanding, status: "pending",
        webhook_payload: { kind: "credit-settle", agent_id: user.userId, payer, payNetwork, amount: outstanding },
      });
      if (pErr) return json({ ok: false, error: pErr.message });
      try {
        const r = await initiateCheckout({ amount: outstanding, reference, phone: payer, network: payNetwork as any });
        await db.from("payment_intents").update({
          webhook_payload: { kind: "credit-settle", agent_id: user.userId, payer, payNetwork, amount: outstanding, transactionId: r.transactionId },
        }).eq("reference", reference);
        return json({ ok: true, reference });
      } catch (e: any) {
        await db.from("payment_intents").update({ status: "failed" }).eq("reference", reference);
        return json({ ok: false, error: String(e?.message || e) });
      }
    }

    if (action === "agent-credit-pay-verify") {
      const reference = String(body.reference || "");
      const { data: intent } = await db.from("payment_intents").select("*")
        .eq("reference", reference).eq("user_id", user.userId).maybeSingle();
      if (!intent) return json({ ok: false, status: "not_found" });
      const wp = (intent.webhook_payload ?? {}) as any;
      if (intent.status === "success") return json({ ok: true, status: "success" });
      if (intent.status === "failed") return json({ ok: true, status: "failed" });
      const txId = wp.transactionId ?? intent.reference;
      const st = await checkStatus(String(txId));
      if (st.status === "success") {
        const { data: updated } = await db.from("payment_intents").update({
          status: "success", webhook_payload: { ...wp, check: st.raw },
        }).eq("id", intent.id).eq("status", "pending").select("id").maybeSingle();
        if (!updated) return json({ ok: true, status: "success" });
        // Clear outstanding + mark all unsettled ledger rows as settled
        const paid = Number(intent.net_amount);
        const { data: cr } = await db.from("agent_credit").select("outstanding").eq("agent_id", user.userId).maybeSingle();
        const cur = Number(cr?.outstanding ?? 0);
        const nextOut = Math.max(0, Math.round((cur - paid) * 100) / 100);
        await db.from("agent_credit").update({ outstanding: nextOut, last_settled_at: new Date().toISOString() }).eq("agent_id", user.userId);
        await db.from("credit_orders_log").update({ settled: true, settled_at: new Date().toISOString(), settlement_reference: reference })
          .eq("agent_id", user.userId).eq("settled", false);
        await db.from("transactions").insert({
          user_id: user.userId, type: "credit_settlement", amount: -paid, balance_after: null,
          reference, description: "Agent credit settlement",
        });
        return json({ ok: true, status: "success" });
      }
      if (st.status === "failed") {
        await db.from("payment_intents").update({ status: "failed" }).eq("id", intent.id);
        return json({ ok: true, status: "failed" });
      }
      return json({ ok: true, status: "pending" });
    }

    return json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[user] error:", e);
    return json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
});
