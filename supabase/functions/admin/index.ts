// deno-lint-ignore-file no-explicit-any
import { adminClient } from "../_shared/admin.ts";
import { handleOptions, json } from "../_shared/cors.ts";
import { mintAdminSession, verifyAdminToken, clearAdminToken } from "../_shared/admin-session.ts";
import { getDataPackages, getOrderStatus as primeOrderStatus } from "../_shared/cheapdata.ts";
import { getServices as smmGetServices, getServicesPage, getBalance as smmGetBalance, getOrderStatus as smmOrderStatus, normalizePlatform, ALLOWED_PLATFORMS } from "../_shared/netwave.ts";

// Simple bcrypt-compatible check using Deno's Web Crypto: we store SHA-256 for simplicity.
// (Prior implementation used bcryptjs — we upgrade to constant-time SHA-256+salt.)
async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireAdmin(req: Request): Promise<boolean> {
  const token = req.headers.get("x-admin-token");
  return verifyAdminToken(token);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const db = adminClient();

    // ---------- AUTH ----------
    if (action === "login") {
      const password = String(body.password || "");
      const { data: row } = await db.from("site_settings").select("value").eq("key", "admin_password_hash").maybeSingle();
      let hash = row?.value as string | undefined;
      if (!hash) {
        // No hardcoded default. One-time setup happens from the ADMIN_INITIAL_PASSWORD
        // secret only; without it the admin panel stays closed.
        const initial = Deno.env.get("ADMIN_INITIAL_PASSWORD") || "";
        if (initial.length < 8) {
          return json({ ok: false, error: "Admin password is not configured. Set the ADMIN_INITIAL_PASSWORD secret (min 8 chars) to complete setup." }, { status: 503 });
        }
        hash = await sha256(initial);
        await db.from("site_settings").upsert({ key: "admin_password_hash", value: hash });
      }
      const attempt = await sha256(password);
      if (attempt !== hash) return json({ ok: false, error: "Wrong password" });
      const token = await mintAdminSession();
      return json({ ok: true, token });
    }

    if (action === "logout") {
      await clearAdminToken(req.headers.get("x-admin-token"));
      return json({ ok: true });
    }

    if (action === "check") {
      const ok = await requireAdmin(req);
      return json({ ok: true, authenticated: ok });
    }

    // Everything below requires admin token
    if (!(await requireAdmin(req))) return json({ ok: false, error: "Unauthorized" }, { status: 401 });

    if (action === "change-password") {
      const password = String(body.password || "");
      if (password.length < 4) return json({ ok: false, error: "Password too short" });
      const hash = await sha256(password);
      await db.from("site_settings").upsert({ key: "admin_password_hash", value: hash });
      return json({ ok: true });
    }

    // ---------- USERS ----------
    if (action === "list-users") {
      const search = String(body.search || "").trim();
      let q = db.from("profiles").select("*").order("created_at", { ascending: false }).limit(500);
      if (search) {
        q = q.or(`email.ilike.%${search}%,username.ilike.%${search}%,phone.ilike.%${search}%,full_name.ilike.%${search}%`);
      }
      const { data: profiles } = await q;
      const ids = (profiles ?? []).map((p: any) => p.id);
      const [wRes, rRes, aRes] = ids.length
        ? await Promise.all([
            db.from("wallets").select("user_id,balance").in("user_id", ids),
            db.from("user_roles").select("user_id,role").in("user_id", ids),
            db.from("agents").select("user_id,active").in("user_id", ids),
          ])
        : [{ data: [] as any[] }, { data: [] as any[] }, { data: [] as any[] }];
      const wmap = new Map<string, number>((wRes.data ?? []).map((w: any) => [w.user_id, Number(w.balance)]));
      const rmap = new Map<string, string>((rRes.data ?? []).map((r: any) => [r.user_id, r.role]));
      const amap = new Map<string, boolean>((aRes.data ?? []).map((a: any) => [a.user_id, !!a.active]));
      return json({ ok: true, rows: (profiles ?? []).map((p: any) => ({
        ...p,
        balance: wmap.get(p.id) ?? 0,
        role: rmap.get(p.id) ?? "user",
        agent_active: amap.get(p.id) ?? false,
      })) });
    }

    if (action === "create-user") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const full_name = String(body.full_name || "").trim();
      const username = String(body.username || "").trim() || `user_${Math.random().toString(36).slice(2, 10)}`;
      const phone = String(body.phone || "").trim();
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) return json({ ok: false, error: "Invalid email" });
      if (password.length < 6) return json({ ok: false, error: "Password must be at least 6 characters" });
      const { data: created, error: cErr } = await db.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { full_name, username, phone },
      });
      if (cErr) return json({ ok: false, error: cErr.message });
      return json({ ok: true, user_id: created.user?.id });
    }

    if (action === "update-user") {
      const user_id = String(body.user_id);
      if (!user_id) return json({ ok: false, error: "Missing user_id" });
      const patch: any = {};
      if (typeof body.full_name === "string") patch.full_name = body.full_name;
      if (typeof body.username === "string") patch.username = body.username;
      if (typeof body.phone === "string") patch.phone = body.phone;
      if (typeof body.email === "string") patch.email = body.email;
      if (Object.keys(patch).length) await db.from("profiles").update(patch).eq("id", user_id);
      if (typeof body.email === "string" && body.email) {
        const { error: eErr } = await db.auth.admin.updateUserById(user_id, { email: body.email });
        if (eErr) return json({ ok: false, error: eErr.message });
      }
      if (typeof body.password === "string" && body.password && body.password.length >= 6) {
        const { error: pErr } = await db.auth.admin.updateUserById(user_id, { password: body.password });
        if (pErr) return json({ ok: false, error: pErr.message });
      }
      return json({ ok: true });
    }

    if (action === "set-user-role") {
      const user_id = String(body.user_id);
      const role = String(body.role || "customer");
      if (!user_id) return json({ ok: false, error: "Missing user_id" });
      if (!["customer", "agent", "admin"].includes(role)) return json({ ok: false, error: "Invalid role" });
      await db.from("user_roles").delete().eq("user_id", user_id);
      await db.from("user_roles").insert({ user_id, role: role === "admin" ? "admin" : "user" });
      if (role === "agent") {
        const { data: existing } = await db.from("agents").select("user_id").eq("user_id", user_id).maybeSingle();
        if (existing) {
          await db.from("agents").update({ active: true, activated_at: new Date().toISOString() }).eq("user_id", user_id);
        } else {
          const { data: prof } = await db.from("profiles").select("username").eq("id", user_id).maybeSingle();
          const store_name = (prof?.username || `store_${user_id.slice(0, 6)}`).toLowerCase().replace(/[^a-z0-9-]/g, "-");
          await db.from("agents").insert({ user_id, store_name, active: true, activated_at: new Date().toISOString() });
        }
      } else {
        await db.from("agents").update({ active: false }).eq("user_id", user_id);
      }
      return json({ ok: true });
    }

    if (action === "ban-user") {
      await db.from("profiles").update({ is_banned: !!body.banned }).eq("id", String(body.user_id));
      return json({ ok: true });
    }

    if (action === "set-order-blocks") {
      const user_id = String(body.user_id || "");
      if (!user_id) return json({ ok: false, error: "Missing user_id" });
      const { error } = await db.from("profiles").update({
        data_orders_blocked: !!body.data_orders_blocked,
        smm_orders_blocked: !!body.smm_orders_blocked,
      }).eq("id", user_id);
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true });
    }

    if (action === "delete-user") {
      const user_id = String(body.user_id);
      if (!user_id) return json({ ok: false, error: "Missing user_id" });
      // Remove dependent rows first (best-effort); auth cascade will clean profile/wallet via FK.
      await db.from("transactions").delete().eq("user_id", user_id);
      await db.from("orders").delete().eq("user_id", user_id);
      await db.from("withdrawals").delete().eq("user_id", user_id);
      await db.from("referrals").delete().or(`referrer_id.eq.${user_id},referred_id.eq.${user_id}`);
      await db.from("payment_intents").delete().eq("user_id", user_id);
      await db.from("wallets").delete().eq("user_id", user_id);
      await db.from("user_roles").delete().eq("user_id", user_id);
      await db.from("profiles").delete().eq("id", user_id);
      const { error: authErr } = await db.auth.admin.deleteUser(user_id);
      if (authErr) return json({ ok: false, error: authErr.message });
      return json({ ok: true });
    }

    if (action === "credit-user") {
      const user_id = String(body.user_id);
      const amount = Number(body.amount);
      const type = String(body.type || "credit"); // credit | debit
      const note = String(body.note || "");
      if (!Number.isFinite(amount) || amount <= 0) return json({ ok: false, error: "Invalid amount" });
      const { data: w } = await db.from("wallets").select("balance").eq("user_id", user_id).maybeSingle();
      const cur = Number(w?.balance ?? 0);
      const delta = type === "credit" ? amount : -amount;
      const next = Math.round((cur + delta) * 100) / 100;
      if (next < 0) return json({ ok: false, error: "Insufficient balance" });
      await db.from("wallets").update({ balance: next }).eq("user_id", user_id);
      await db.from("transactions").insert({
        user_id, type: type === "credit" ? "topup" : "adjustment",
        amount: delta, balance_after: next,
        description: note || (type === "credit" ? "Admin credit" : "Admin debit"),
      });
      return json({ ok: true, balance: next });
    }




    // ---------- SMS (Moolre) ----------
    if (action === "sms-list-senders") {
      const vaskey = Deno.env.get("MOOLRE_VASKEY");
      const apiToken = Deno.env.get("MOOLRE_API_TOKEN");
      if (!vaskey) return json({ ok: false, error: "MOOLRE_VASKEY not configured" });
      try {
        const res = await fetch("https://api.moolre.com/open/sms/status", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-VASKEY": vaskey,
            ...(apiToken ? { "X-API-USER": apiToken, Authorization: `Bearer ${apiToken}` } : {}),
          },
          body: JSON.stringify({ type: 7 }),
        });
        const txt = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(txt); } catch { /* noop */ }
        const raw = parsed?.data;
        const arr: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.senderids) ? raw.senderids : Array.isArray(raw?.data) ? raw.data : [];
        const senders = arr
          .map((s: any) => (typeof s === "string"
            ? { senderid: s, status: null }
            : { senderid: String(s.senderid ?? s.sender ?? s.name ?? "").trim(), status: s.approval ?? s.status ?? s.state ?? null }))
          .filter((s) => s.senderid)
          .filter((s) => !s.status || /approv/i.test(String(s.status)));
        if (!res.ok || parsed?.status !== 1) {
          return json({ ok: false, error: String(parsed?.message || parsed?.error || `HTTP ${res.status} ${txt}`).slice(0, 300), senders });
        }
        return json({ ok: true, senders, raw: parsed?.data ?? null });
      } catch (e) {
        return json({ ok: false, error: `Network error — ${String((e as Error).message || e).slice(0, 200)}` });
      }
    }

    if (action === "send-bulk-sms") {
      const message = String(body.message || "").trim();
      const senderid = String(body.senderid || "SmartDeal").trim().slice(0, 11);
      const all = !!body.all;
      const userIds: string[] = Array.isArray(body.user_ids) ? body.user_ids.map(String) : [];
      const rawPhones: string[] = Array.isArray(body.phones) ? body.phones.map((s: any) => String(s).trim()).filter(Boolean) : [];
      if (!message) return json({ ok: false, error: "Message required" });
      if (!senderid) return json({ ok: false, error: "Sender ID required" });

      const norm = (p: string) => {
        const d = String(p).replace(/\D/g, "");
        if (d.length === 12 && d.startsWith("233")) return d;
        if (d.length === 10 && d.startsWith("0")) return "233" + d.slice(1);
        if (d.length === 9) return "233" + d;
        return d.length >= 10 ? d : "";
      };

      const recipients = new Set<string>();
      const invalid: string[] = [];
      for (const p of rawPhones) {
        const n = norm(p);
        if (n) recipients.add(n);
        else if (invalid.length < 50) invalid.push(p);
      }
      if (all || userIds.length) {
        let q = db.from("profiles").select("phone");
        if (!all) q = q.in("id", userIds);
        const { data, error } = await q;
        if (error) return json({ ok: false, error: `Could not load recipients: ${error.message}` });
        for (const r of (data ?? [])) {
          const raw = String((r as any).phone || "");
          const n = norm(raw);
          if (n) recipients.add(n);
          else if (raw && invalid.length < 50) invalid.push(raw);
        }
      }
      const list = Array.from(recipients);
      if (!list.length) {
        return json({ ok: false, error: `No valid phone numbers${invalid.length ? ` — ${invalid.length} entr${invalid.length === 1 ? "y" : "ies"} rejected (e.g. ${invalid.slice(0, 3).join(", ")})` : ""}` });
      }

      const vaskey = Deno.env.get("MOOLRE_VASKEY");
      const apiToken = Deno.env.get("MOOLRE_API_TOKEN");
      if (!vaskey) return json({ ok: false, error: "MOOLRE_VASKEY not configured" });

      let ok = 0, fail = 0;
      const errors: string[] = [];
      let balance: unknown = null;
      const chunk = 50;
      for (let i = 0; i < list.length; i += chunk) {
        const batch = list.slice(i, i + chunk);
        const label = `batch ${Math.floor(i / chunk) + 1} (${batch[0]}…${batch[batch.length - 1]}, ${batch.length} recipient${batch.length === 1 ? "" : "s"})`;
        try {
          const res = await fetch("https://api.moolre.com/open/sms/send", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-VASKEY": vaskey,
              ...(apiToken ? { "X-API-USER": apiToken, Authorization: `Bearer ${apiToken}` } : {}),
            },
            body: JSON.stringify({
              type: 1,
              senderid,
              messages: batch.map((recipient) => ({ recipient, message })),
            }),
          });
          const txt = await res.text();
          let parsed: any = null;
          try { parsed = JSON.parse(txt); } catch { /* noop */ }
          if (parsed?.data?.balance != null) balance = parsed.data.balance;
          else if (parsed?.balance != null) balance = parsed.balance;

          const perMessage: any[] = Array.isArray(parsed?.data?.messages)
            ? parsed.data.messages
            : Array.isArray(parsed?.messages) ? parsed.messages : [];
          const rejected = perMessage.filter((m) => m && (m.status === 0 || m.status === "0" || m.error || m.errors));

          if (res.ok && parsed?.status === 1 && !rejected.length) {
            ok += batch.length;
          } else if (res.ok && parsed?.status === 1 && rejected.length) {
            ok += batch.length - rejected.length;
            fail += rejected.length;
            for (const m of rejected.slice(0, 10)) {
              if (errors.length < 20) {
                errors.push(`${m.recipient || "unknown"}: ${String(m.message || m.error || "rejected by provider").slice(0, 160)}`);
              }
            }
          } else {
            fail += batch.length;
            const detail = parsed
              ? String(parsed.message || parsed.error || JSON.stringify(parsed)).slice(0, 240)
              : `HTTP ${res.status} ${txt}`.slice(0, 240);
            if (errors.length < 20) errors.push(`${label}: ${detail}`);
          }
        } catch (e) {
          fail += batch.length;
          if (errors.length < 20) errors.push(`${label}: network error — ${String((e as Error).message || e).slice(0, 200)}`);
        }
      }
      return json({
        ok: true,
        sent: ok,
        failed: fail,
        total: list.length,
        skipped: invalid.length,
        invalid: invalid.slice(0, 20),
        balance,
        errors,
      });
    }

    // ---------- TRANSACTIONS / REFERRALS / WITHDRAWALS ----------
    if (action === "list-transactions") {
      const search = String(body.search || "").trim();
      let q = db.from("transactions").select("*").order("created_at", { ascending: false }).limit(500);
      if (search) q = q.or(`description.ilike.%${search}%,reference.ilike.%${search}%,type.ilike.%${search}%`);
      const { data } = await q;
      const rows = data ?? [];
      const userIds = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));
      let pmap: Record<string, any> = {};
      if (userIds.length) {
        const { data: profs } = await db.from("profiles").select("id, username, full_name, email, phone").in("id", userIds);
        for (const p of profs ?? []) pmap[p.id] = p;
      }
      return json({ ok: true, rows: rows.map((r: any) => ({ ...r, profiles: pmap[r.user_id] ?? null })) });
    }


    if (action === "list-referrals") {
      const { data } = await db.from("referrals").select("*, referrer:referrer_id(username,email), referred:referred_id(username,email)").order("created_at", { ascending: false }).limit(500);
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "list-withdrawals") {
      const { data } = await db.from("withdrawals").select("*, profiles:user_id(username,email,phone)").order("created_at", { ascending: false }).limit(500);
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "update-withdrawal") {
      const id = String(body.id);
      const status = String(body.status);
      const note = String(body.note || "");
      if (!["approved", "rejected", "paid"].includes(status)) return json({ ok: false, error: "Invalid status" });
      await db.from("withdrawals").update({ status, admin_note: note || null }).eq("id", id);
      return json({ ok: true });
    }

    // ---------- SETTINGS ----------
    if (action === "get-settings") {
      const { data } = await db.from("site_settings").select("key,value");
      return json({ ok: true, rows: (data ?? []).filter((r: any) => r.key !== "admin_password_hash") });
    }

    if (action === "update-setting") {
      const key = String(body.key || "").trim();
      if (!key || key === "admin_password_hash") return json({ ok: false, error: "Invalid key" });
      await db.from("site_settings").upsert({ key, value: body.value });
      return json({ ok: true });
    }

    // ---------- PROVIDER HEALTH ----------
    if (action === "provider-health") {
      const out: Record<string, any> = {};
      try {
        const { gatewayName } = await import("../_shared/gateway.ts");
        const { ping } = await import("../_shared/tpay.ts");
        out.payments = { gateway: gatewayName(), ...(await ping()) };
      } catch (e) { out.payments = { ok: false, error: String((e as Error).message).slice(0, 200) }; }
      try {
        const { getBalance } = await import("../_shared/cheapdata.ts");
        out.data = { ok: true, balance: await getBalance() };
      } catch (e) { out.data = { ok: false, error: String((e as Error).message).slice(0, 200) }; }
      try {
        out.boosting = { ok: true, ...(await smmGetBalance()) };
      } catch (e) { out.boosting = { ok: false, error: String((e as Error).message).slice(0, 200) }; }
      return json({ ok: true, providers: out });
    }

    // ---------- PROVIDER WALLET BALANCES (in GHS) ----------
    if (action === "provider-balances") {
      const out: Record<string, any> = {};
      try {
        const { getBalance } = await import("../_shared/cheapdata.ts");
        const r: any = await getBalance();
        const d = r?.data ?? r ?? {};
        out.data = {
          ok: true,
          ghs: Number(d?.balance ?? d?.wallet ?? 0),
          currency: String(d?.currency ?? "GHS"),
        };
      } catch (e) { out.data = { ok: false, error: String((e as Error).message).slice(0, 200) }; }
      try {
        const b: any = await smmGetBalance();
        out.boosting = {
          ok: true,
          xd: Number(b?.wallet_balance_xd ?? 0),
          ghs: b?.wallet_balance_local ?? null,
          rate: b?.rate ?? null,
        };
      } catch (e) { out.boosting = { ok: false, error: String((e as Error).message).slice(0, 200) }; }
      return json({ ok: true, ...out });
    }

    // ---------- QUEUED ORDERS (provider wallet was empty) ----------
    if (action === "data-insufficient-list") {
      const { data } = await db.from("orders").select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false }).limit(500);
      const rows = (data ?? []).filter((o: any) => (o.api_response as any)?.api_insufficient === true);
      const ids = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));
      const pmap: Record<string, any> = {};
      if (ids.length) {
        const { data: profs } = await db.from("profiles").select("id, username, full_name, phone, email").in("id", ids);
        for (const p of profs ?? []) pmap[p.id] = p;
      }
      return json({ ok: true, rows: rows.map((r: any) => ({ ...r, user: pmap[r.user_id] ?? null })) });
    }

    if (action === "data-insufficient-retry") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const { createOrder: primeCreateOrder, isProviderInsufficient } = await import("../_shared/cheapdata.ts");
      let q = db.from("orders").select("*").eq("status", "pending").limit(500);
      if (ids.length) q = q.in("id", ids);
      const { data } = await q;
      const rows = (data ?? []).filter((o: any) => (o.api_response as any)?.api_insufficient === true);
      let sent = 0, stillEmpty = 0, failed = 0;
      for (const o of rows) {
        try {
          const apiRes: any = await primeCreateOrder({
            package_id: o.plan_code, phone: o.phone, reference: o.api_reference ?? undefined,
          });
          const st = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
          const success = apiRes?.success === true || ["success", "completed", "pending", "processing"].includes(st);
          if (!success) throw new Error(apiRes?.error ?? apiRes?.message ?? "API returned failure");
          await db.from("orders").update({
            status: ["completed", "success"].includes(st) ? "completed" : "processing",
            api_response: {
              ...(o.api_response as any ?? {}),
              ...apiRes,
              api_insufficient: false,
            },
          }).eq("id", o.id);
          sent++;
        } catch (e) {
          if (isProviderInsufficient(e)) { stillEmpty++; continue; }
          await db.from("orders").update({
            api_response: { ...(o.api_response as any ?? {}), retry_error: String((e as Error).message).slice(0, 300) },
          }).eq("id", o.id);
          failed++;
        }
      }
      return json({ ok: true, total: rows.length, sent, stillEmpty, failed });
    }

    // Re-asks the payment provider about dial-in orders we recorded as unpaid or
    // failed. A dropped callback used to leave a genuinely paid order marked
    // failed; if the provider now reports success we mark it paid and deliver it.
    if (action === "ussd-recheck-payments") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const { checkStatus } = await import("../_shared/gateway.ts");
      const { createOrder: primeCreateOrder, isProviderInsufficient } = await import("../_shared/cheapdata.ts");
      const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
      let q = db.from("orders").select("*").eq("source", "ussd")
        .in("status", ["failed", "pending"]).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(200);
      if (ids.length) q = q.in("id", ids);
      const { data } = await q;
      const rows = (data ?? []).filter((o: any) => (o.api_response as any)?.paid !== true);
      let rescued = 0, delivered = 0, queued = 0, stillUnpaid = 0;
      for (const o of rows) {
        const txId = String((o.api_response as any)?.transactionId || o.api_reference || "");
        if (!txId) { stillUnpaid++; continue; }
        const st = await checkStatus(txId);
        if (st.status !== "success") { stillUnpaid++; continue; }
        rescued++;
        const base = { ...(o.api_response as any ?? {}), paid: true, recheck: st.raw ?? null };
        try {
          const apiRes: any = await primeCreateOrder({
            package_id: o.plan_code, phone: o.phone, reference: o.api_reference ?? undefined,
          });
          const s = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "").toLowerCase();
          const ok = apiRes?.success === true || ["success", "completed", "pending", "processing"].includes(s);
          if (!ok) throw new Error(apiRes?.error ?? apiRes?.message ?? "delivery failed");
          await db.from("orders").update({
            status: ["completed", "success"].includes(s) ? "completed" : "processing",
            api_response: { ...base, ...apiRes, api_insufficient: false },
          }).eq("id", o.id);
          delivered++;
        } catch (e) {
          const msg = String((e as Error).message).slice(0, 300);
          await db.from("orders").update({
            status: "pending",
            api_response: { ...base, api_insufficient: isProviderInsufficient(e) ? true : undefined, error: msg },
          }).eq("id", o.id);
          queued++;
        }
      }
      return json({ ok: true, checked: rows.length, rescued, delivered, queued, stillUnpaid });
    }

    if (action === "smm-insufficient-list") {
      const { data } = await db.from("smm_orders").select("*")
        .eq("status", "pending").order("created_at", { ascending: false }).limit(500);
      const rows = (data ?? []).filter((o: any) => (o.raw as any)?.api_insufficient === true);
      const ids = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));
      const pmap: Record<string, any> = {};
      if (ids.length) {
        const { data: profs } = await db.from("profiles").select("id, username, full_name, phone, email").in("id", ids);
        for (const p of profs ?? []) pmap[p.id] = p;
      }
      return json({ ok: true, rows: rows.map((r: any) => ({ ...r, user: pmap[r.user_id] ?? null })) });
    }

    if (action === "smm-insufficient-retry") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const { placeOrder, isProviderInsufficient } = await import("../_shared/netwave.ts");
      let q = db.from("smm_orders").select("*").eq("status", "pending").limit(500);
      if (ids.length) q = q.in("id", ids);
      const { data } = await q;
      const rows = (data ?? []).filter((o: any) => (o.raw as any)?.api_insufficient === true);
      let sent = 0, stillEmpty = 0, failed = 0;
      for (const o of rows) {
        try {
          const apiRes: any = await placeOrder({
            service_id: Number(o.service_id), provider: o.provider, link: o.link, quantity: Number(o.quantity),
          });
          const providerOrderId = String(apiRes?.data?.order_id ?? apiRes?.order_id ?? apiRes?.data?.order?.id ?? "");
          if (!providerOrderId) throw new Error(String(apiRes?.error ?? apiRes?.message ?? "Provider rejected the order"));
          const st = String(apiRes?.data?.order?.status ?? apiRes?.data?.status ?? apiRes?.status ?? "pending").toLowerCase();
          await db.from("smm_orders").update({
            provider_order_id: providerOrderId,
            status: ["completed", "success"].includes(st) ? "completed" : (["processing", "in progress"].includes(st) ? "processing" : "pending"),
            raw: apiRes,
          }).eq("id", o.id);
          sent++;
        } catch (e) {
          if (isProviderInsufficient(e)) { stillEmpty++; continue; }
          await db.from("smm_orders").update({
            raw: { ...(o.raw as any ?? {}), retry_error: String((e as Error).message).slice(0, 300) },
          }).eq("id", o.id);
          failed++;
        }
      }
      return json({ ok: true, total: rows.length, sent, stillEmpty, failed });
    }

    // ---------- CANCEL A QUEUED ORDER (refund the customer) ----------
    // Refunds to the wallet, or clears the credit debt when the order was
    // bought on credit, then marks the order as refunded/failed.
    const refundQueued = async (opts: {
      userId: string | null; amount: number; reference: string | null;
      description: string; meta: Record<string, unknown>; orderId: string; orderType: "data" | "smm";
    }) => {
      if (!opts.userId || !(opts.amount > 0)) return;
      if (opts.orderType === "data") {
        const { data: creditLog } = await db.from("credit_orders_log")
          .select("*").eq("order_id", opts.orderId).eq("settled", false).maybeSingle();
        if (creditLog) {
          const { data: cr } = await db.from("agent_credit").select("outstanding").eq("agent_id", opts.userId).maybeSingle();
          const next = Math.max(0, Math.round((Number(cr?.outstanding ?? 0) - opts.amount) * 100) / 100);
          await db.from("agent_credit").update({ outstanding: next }).eq("agent_id", opts.userId);
          await db.from("credit_orders_log").delete().eq("id", creditLog.id);
          await db.from("transactions").insert({
            user_id: opts.userId, type: "refund", amount: opts.amount, balance_after: null,
            reference: opts.reference, description: `${opts.description} (credit reversed)`, meta: opts.meta,
          });
          return;
        }
      }
      const { data: w } = await db.from("wallets").select("balance").eq("user_id", opts.userId).maybeSingle();
      const nb = Math.round((Number(w?.balance ?? 0) + opts.amount) * 100) / 100;
      await db.from("wallets").update({ balance: nb }).eq("user_id", opts.userId);
      await db.from("transactions").insert({
        user_id: opts.userId, type: "refund", amount: opts.amount, balance_after: nb,
        reference: opts.reference, description: opts.description, meta: opts.meta,
      });
    };

    if (action === "data-insufficient-cancel") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
      let q = db.from("orders").select("*").eq("status", "pending").limit(500);
      if (ids.length) q = q.in("id", ids);
      const { data } = await q;
      const rows = (data ?? []).filter((o: any) => (o.api_response as any)?.api_insufficient === true);
      for (const o of rows) {
        await refundQueued({
          userId: o.user_id ?? null, amount: Number(o.amount_charged), reference: o.api_reference ?? null,
          description: `Refund (cancelled): ${o.plan_name} (${o.network})`,
          meta: { order_id: o.id, cancelled_by_admin: true },
          orderId: o.id, orderType: "data",
        });
        await db.from("orders").update({
          status: "refunded",
          api_response: { ...(o.api_response as any ?? {}), cancelled_by_admin: true },
        }).eq("id", o.id);
      }
      return json({ ok: true, cancelled: rows.length });
    }

    if (action === "smm-insufficient-cancel") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
      let q = db.from("smm_orders").select("*").eq("status", "pending").limit(500);
      if (ids.length) q = q.in("id", ids);
      const { data } = await q;
      const rows = (data ?? []).filter((o: any) => (o.raw as any)?.api_insufficient === true);
      for (const o of rows) {
        await refundQueued({
          userId: o.user_id ?? null, amount: Number(o.amount_charged), reference: null,
          description: `Refund (cancelled): ${o.platform} · ${o.service_name}`,
          meta: { smm_order_id: o.id, cancelled_by_admin: true },
          orderId: o.id, orderType: "smm",
        });
        await db.from("smm_orders").update({
          status: "refunded",
          raw: { ...(o.raw as any ?? {}), cancelled_by_admin: true },
        }).eq("id", o.id);
      }
      return json({ ok: true, cancelled: rows.length });
    }



    // ---------- PLANS / PRICING ----------
    if (action === "list-plans") {
      const search = String(body.search || "").trim();
      let q = db.from("data_plans").select("*").order("network").order("sort_order").order("api_price").limit(500);
      if (search) q = q.or(`name.ilike.%${search}%,network.ilike.%${search}%,plan_code.ilike.%${search}%`);
      const { data } = await q;
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "sync-plans") {
      const packages = await getDataPackages();
      if (!packages.length) return json({ ok: false, error: "Provider returned no packages" });

      // ---- Wipe every existing plan first: the new provider is the only source of truth ----
      const { data: oldPlans } = await db.from("data_plans").select("id");
      const oldIds = (oldPlans ?? []).map((r: any) => r.id);
      let removed = 0;
      let deactivated = 0;
      for (let i = 0; i < oldIds.length; i += 50) {
        const chunk = oldIds.slice(i, i + 50);
        await db.from("agent_plans").delete().in("plan_id", chunk);
        const { error: delErr } = await db.from("data_plans").delete().in("id", chunk);
        if (delErr) {
          for (const id of chunk) {
            const { error: e1 } = await db.from("data_plans").delete().eq("id", id);
            if (e1) {
              // Referenced by historical orders — keep the row but switch it off
              await db.from("data_plans").update({ active: false }).eq("id", id);
              deactivated++;
            } else removed++;
          }
        } else removed += chunk.length;
      }

      // ---- Insert fresh plans from the provider ----
      let synced = 0;
      let sort = 0;
      for (const p of packages) {
        const plan_code = String((p as any).id ?? "").trim();
        if (!plan_code) continue;
        const network = String((p as any).network_display ?? (p as any).network ?? "").toUpperCase();
        const size = (p as any).size ?? null;
        const validity = (p as any).validity ?? null;
        const name = size ? `${size}GB` : `Plan ${plan_code}`;
        const api_price = Number((p as any).price ?? 0);
        const active = (p as any).is_active !== false;
        const markup = 10;
        const agentMarkup = 20;
        await db.from("data_plans").upsert({
          network, plan_code, name,
          size: size?.toString() ?? null, validity: validity?.toString() ?? null,
          api_price,
          markup_percent: markup,
          custom_price: Math.round(api_price * (1 + markup / 100) * 100) / 100,
          agent_markup_percent: agentMarkup,
          agent_price: Math.round(api_price * (1 + agentMarkup / 100) * 100) / 100,
          auto_rate: true, active, sort_order: sort++,
        }, { onConflict: "network,plan_code" });
        synced++;
      }

      return json({ ok: true, synced, removed, deactivated });

    }


    if (action === "create-plan") {
      const network = String(body.network ?? "").trim().toUpperCase();
      const name = String(body.name ?? "").trim();
      let plan_code = String(body.plan_code ?? "").trim();
      const api_price = Number(body.api_price);
      if (!network) return json({ ok: false, error: "Network is required" });
      if (!name) return json({ ok: false, error: "Plan name is required" });
      if (!plan_code) {
        const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "PLAN";
        plan_code = `M-${network}-${slug}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      }
      if (!isFinite(api_price) || api_price < 0) return json({ ok: false, error: "Invalid API price" });
      const markup_percent = Number(body.markup_percent ?? 10);
      const agent_markup_percent = Number(body.agent_markup_percent ?? 20);
      const auto_rate = body.auto_rate === undefined ? true : !!body.auto_rate;
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const custom_price = auto_rate || body.custom_price === undefined || body.custom_price === ""
        ? round2(api_price * (1 + markup_percent / 100))
        : Number(body.custom_price);
      const agent_price = auto_rate || body.agent_price === undefined || body.agent_price === "" || body.agent_price === null
        ? round2(api_price * (1 + agent_markup_percent / 100))
        : Number(body.agent_price);
      const { data: dup } = await db.from("data_plans").select("id").eq("network", network).eq("plan_code", plan_code).maybeSingle();
      if (dup) return json({ ok: false, error: "A plan with this network and code already exists" });
      const { error } = await db.from("data_plans").insert({
        network, plan_code, name,
        size: body.size ? String(body.size) : null,
        validity: body.validity ? String(body.validity) : null,
        api_price, markup_percent, custom_price,
        agent_markup_percent, agent_price,
        auto_rate,
        active: body.active === undefined ? true : !!body.active,
        sort_order: Number(body.sort_order ?? 0) || 0,
      });
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true });
    }

    if (action === "delete-plan") {
      const delId = String(body.id ?? "");
      if (!delId) return json({ ok: false, error: "Plan id is required" });
      await db.from("agent_plans").delete().eq("plan_id", delId);
      const { error } = await db.from("data_plans").delete().eq("id", delId);
      if (error) return json({ ok: false, error: error.message });
      return json({ ok: true });
    }

    if (action === "update-plan") {
      const id = String(body.id);
      const { data: plan } = await db.from("data_plans").select("*").eq("id", id).maybeSingle();
      if (!plan) return json({ ok: false, error: "Not found" });
      const patch: any = {};
      if (body.active !== undefined) patch.active = !!body.active;
      if (body.auto_rate !== undefined) patch.auto_rate = !!body.auto_rate;
      if (body.markup_percent !== undefined) patch.markup_percent = Number(body.markup_percent);
      if (body.custom_price !== undefined) patch.custom_price = Number(body.custom_price);
      if (body.agent_markup_percent !== undefined) patch.agent_markup_percent = Number(body.agent_markup_percent);
      if (body.agent_price !== undefined) patch.agent_price = body.agent_price === null || body.agent_price === "" ? null : Number(body.agent_price);
      const nextAuto = body.auto_rate ?? plan.auto_rate;
      const nextMarkup = body.markup_percent ?? Number(plan.markup_percent);
      const nextAgentMarkup = body.agent_markup_percent ?? Number(plan.agent_markup_percent ?? 20);
      if (nextAuto && body.custom_price === undefined) {
        patch.custom_price = Math.round(Number(plan.api_price) * (1 + Number(nextMarkup) / 100) * 100) / 100;
      }
      if (nextAuto && body.agent_price === undefined) {
        patch.agent_price = Math.round(Number(plan.api_price) * (1 + Number(nextAgentMarkup) / 100) * 100) / 100;
      }
      await db.from("data_plans").update(patch).eq("id", id);
      return json({ ok: true });
    }

    if (action === "set-global-markup") {
      const markup = Number(body.markup_percent);
      const agentMarkup = body.agent_markup_percent !== undefined ? Number(body.agent_markup_percent) : null;
      if (!Number.isFinite(markup)) return json({ ok: false, error: "Invalid markup" });
      // Fetch ALL plans in pages of 1000
      const all: any[] = [];
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const { data: pageRows, error: pErr } = await db.from("data_plans")
          .select("id,api_price,agent_markup_percent")
          .range(offset, offset + pageSize - 1);
        if (pErr) return json({ ok: false, error: pErr.message });
        const rows = pageRows ?? [];
        all.push(...rows);
        if (rows.length < pageSize) break;
        offset += pageSize;
      }
      const conc = 40;
      let updated = 0;
      for (let i = 0; i < all.length; i += conc) {
        const chunk = all.slice(i, i + conc);
        const res = await Promise.all(chunk.map(async (p: any) => {
          const custom_price = Math.round(Number(p.api_price) * (1 + markup / 100) * 100) / 100;
          const am = agentMarkup != null ? agentMarkup : Number(p.agent_markup_percent ?? 20);
          const agent_price = Math.round(Number(p.api_price) * (1 + am / 100) * 100) / 100;
          const patch: any = { markup_percent: markup, custom_price, agent_price, auto_rate: true };
          if (agentMarkup != null) patch.agent_markup_percent = agentMarkup;
          const { error } = await db.from("data_plans").update(patch).eq("id", p.id);
          return !error;
        }));
        updated += res.filter(Boolean).length;
      }
      return json({ ok: true, updated, total: all.length });
    }


    // ---------- ORDERS ----------
    if (action === "list-orders") {
      const search = String(body.search || "").trim();
      const status = String(body.status || "").trim();
      let q = db.from("orders").select("*").order("created_at", { ascending: false }).limit(500);
      if (status && status !== "all") q = q.eq("status", status);
      if (search) q = q.or(`phone.ilike.%${search}%,plan_name.ilike.%${search}%,network.ilike.%${search}%,api_reference.ilike.%${search}%`);
      const { data } = await q;
      // Dial-in (USSD) orders only enter the main list after payment and after
      // they have left the provider-insufficient queue. Failed USSD attempts
      // stay out of Orders entirely.
      const rows = (data ?? []).filter((r: any) =>
        String(r.source) !== "ussd" || (
          r?.api_response?.paid === true &&
          r?.api_response?.api_insufficient !== true &&
          !["failed", "refunded"].includes(String(r.status))
        ));
      const userIds = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));
      let profileMap: Record<string, any> = {};
      if (userIds.length) {
        const { data: profs } = await db.from("profiles").select("id, username, full_name, email, phone").in("id", userIds);
        for (const p of profs ?? []) profileMap[p.id] = p;
      }
      const enriched = rows.map((r: any) => ({ ...r, user: profileMap[r.user_id] ?? null }));
      return json({ ok: true, rows: enriched });
    }

    if (action === "sync-orders") {
      const { data: orders } = await db.from("orders").select("*")
        .in("status", ["pending", "processing"])
        .order("created_at", { ascending: false }).limit(100);
      let updated = 0;
      for (const o of orders ?? []) {
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
          await db.from("orders").update({ status: next, api_response: { ...(o.api_response ?? {}), ...res } }).eq("id", o.id);
          updated++;
          if (needsRefund) {
            const { data: w } = await db.from("wallets").select("balance").eq("user_id", o.user_id).maybeSingle();
            const nb = Math.round((Number(w?.balance ?? 0) + Number(o.amount_charged)) * 100) / 100;
            await db.from("wallets").update({ balance: nb }).eq("user_id", o.user_id);
            await db.from("transactions").insert({
              user_id: o.user_id, type: "refund", amount: Number(o.amount_charged),
              balance_after: nb, reference: o.api_reference,
              description: `Refund (${raw}): ${o.plan_name} (${o.network})`, meta: { order_id: o.id, provider_status: raw },
            });
            await db.from("orders").update({ status: "refunded" }).eq("id", o.id);
          }

        } catch { /* skip */ }
      }
      return json({ ok: true, checked: orders?.length ?? 0, updated });
    }

    // ---------- AGENTS ----------
    if (action === "list-agents") {
      const search = String(body.search || "").trim();
      let q = db.from("agents").select("*, profiles:user_id(username,email,phone,full_name)").order("created_at", { ascending: false }).limit(500);
      if (search) q = q.or(`store_name.ilike.%${search}%`);
      const { data } = await q;
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "list-agent-withdrawals") {
      const { data } = await db.from("agent_withdrawals")
        .select("*, agents:agent_id(store_name, profiles:user_id(username,email,phone))")
        .order("created_at", { ascending: false }).limit(500);
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "update-agent-withdrawal") {
      const id = String(body.id);
      const status = String(body.status);
      const note = String(body.note || "");
      if (!["approved", "rejected", "paid"].includes(status)) return json({ ok: false, error: "Invalid status" });
      if (status === "rejected") {
        const { data: wd } = await db.from("agent_withdrawals").select("*").eq("id", id).maybeSingle();
        if (wd && wd.status === "pending") {
          const { data: ag } = await db.from("agents").select("profit_balance").eq("user_id", wd.agent_id).maybeSingle();
          const nb = Math.round((Number(ag?.profit_balance ?? 0) + Number(wd.amount)) * 100) / 100;
          await db.from("agents").update({ profit_balance: nb }).eq("user_id", wd.agent_id);
        }
      }
      await db.from("agent_withdrawals").update({ status, note: note || null }).eq("id", id);
      return json({ ok: true });
    }

    if (action === "list-agent-orders") {
      const search = String(body.search || "").trim();
      let q = db.from("agent_orders")
        .select("*, agents:agent_id(store_name), data_plans(name,network)")
        .order("created_at", { ascending: false }).limit(500);
      if (search) q = q.or(`buyer_phone.ilike.%${search}%,payment_reference.ilike.%${search}%`);
      const { data } = await q;
      return json({ ok: true, rows: data ?? [] });
    }

    // ================= SMM =================
    if (action === "smm-list-services") {
      const search = String(body.search || "").trim();
      const platform = String(body.platform || "").trim();
      const rows: any[] = [];
      const pageSize = 1000;
      for (let from = 0; from < 100000; from += pageSize) {
        let q = db.from("smm_services")
          .select("*")
          .order("platform")
          .order("category")
          .order("custom_price_per_1000")
          .range(from, from + pageSize - 1);
        if (platform && platform !== "all") q = q.eq("platform", platform);
        if (search) q = q.or(`name.ilike.%${search}%,category.ilike.%${search}%,platform.ilike.%${search}%`);
        const { data, error } = await q;
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
      }
      return json({ ok: true, rows });
    }

    if (action === "smm-diag-sample") {
      const { getServicesPage } = await import("../_shared/netwave.ts");
      const services = await getServicesPage(1, 50);
      return json({ ok: true, count: services.length, sample: services.slice(0, 3) });
    }

    if (action === "smm-diag-categories") {
      const { getServicesRaw } = await import("../_shared/netwave.ts");
      const raw = await getServicesRaw();
      const meta = { keys: raw && typeof raw === "object" ? Object.keys(raw) : [], dataLen: Array.isArray(raw?.data) ? raw.data.length : null, pagination: raw?.pagination ?? raw?.meta ?? null };
      const services = await smmGetServices();
      const counts: Record<string, number> = {};
      for (const s of services) {
        const c = String((s as any).category ?? "");
        counts[c] = (counts[c] ?? 0) + 1;
      }
      const rows = Object.entries(counts).map(([category, count]) => ({ category, count, platform: normalizePlatform(category) }));
      rows.sort((a, b) => b.count - a.count);
      return json({ ok: true, total: services.length, meta, rows });
    }

    if (action === "smm-sync-services") {
      const ifStale = !!body.if_stale;
      const STALE_MS = 24 * 60 * 60 * 1000;
      const startPage = Math.max(1, Math.floor(Number(body.page ?? 1)) || 1);
      const pageSizeProv = 500;
      const BUDGET_MS = 20000;
      const startedAt = Date.now();

      const { data: syncSetting } = await db.from("site_settings")
        .select("key,value").eq("key", "smm_last_sync_at").maybeSingle();
      const lastSyncAt = syncSetting?.value ? String((syncSetting.value as any).at ?? syncSetting.value) : null;
      if (ifStale && lastSyncAt && startPage === 1) {
        const age = Date.now() - new Date(lastSyncAt).getTime();
        if (Number.isFinite(age) && age < STALE_MS) {
          return json({ ok: true, skippedSync: true, reason: "fresh", lastSyncAt });
        }
      }

      const { data: mkSetting } = await db.from("site_settings")
        .select("value").eq("key", "smm_default_markup").maybeSingle();
      const defaultMarkup = Number((mkSetting?.value as any)?.percent ?? mkSetting?.value ?? 30) || 30;

      const { getServicesPage: smmGetPage } = await import("../_shared/netwave.ts");

      let skipped = 0, added = 0, updated = 0, synced = 0, checked = 0;
      let page = startPage;
      let hasMore = false;
      const withoutCustom: any[] = [];

      while (true) {
        const services = await smmGetPage(page, pageSizeProv);
        checked += services.length;
        if (services.length === 0) { hasMore = false; break; }

        const incoming: any[] = [];
        for (const s of services) {
          const platform = normalizePlatform(String((s as any).category ?? ""), String((s as any).name ?? ""))
            ?? (ALLOWED_PLATFORMS as readonly string[]).find((p) => p.toLowerCase() === String((s as any).platform ?? "").toLowerCase())
            ?? null;
          const service_id = Number((s as any).id);
          const provider = String((s as any).provider ?? "bwmxmd");
          const priceLocal = Number(
            (s as any).price_per_1000 ?? (s as any).rate ?? (s as any).price_per_1000_ghs ?? 0,
          );
          const blocked = /financial|crypto|forex|loan|casino|\bbet\b|adult/i
            .test(`${(s as any).name ?? ""} ${(s as any).category ?? ""}`);
          if (!platform || !service_id || !priceLocal || blocked) { skipped++; continue; }
          incoming.push({ s, platform, service_id, provider, priceLocal });
        }


        for (let i = 0; i < incoming.length; i += 200) {
          const batch = incoming.slice(i, i + 200);
          const serviceIds = Array.from(new Set(batch.map((x) => x.service_id)));
          const { data: existingRows, error: existingError } = await db.from("smm_services")
            .select("service_id,provider,markup_percent,auto_markup,custom_price_per_1000")
            .in("service_id", serviceIds);
          if (existingError) throw existingError;
          const existingMap = new Map<string, any>((existingRows ?? []).map((r: any) => [`${r.service_id}:${r.provider}`, r]));
          const rows = batch.map(({ s, platform, service_id, provider, priceLocal }) => {
            const existing = existingMap.get(`${service_id}:${provider}`);
            if (existing) updated++; else added++;
            const markup = existing?.markup_percent != null ? Number(existing.markup_percent) : defaultMarkup;
            const autoMk = existing ? existing.auto_markup : true;
            const hasCustom = !!existing && !autoMk && existing.custom_price_per_1000 != null;
            const custom = hasCustom
              ? Number(existing.custom_price_per_1000)
              : Math.round(priceLocal * (1 + markup / 100) * 10000) / 10000;
            if (!hasCustom) {
              withoutCustom.push({ service_id, provider, platform, name: String((s as any).name ?? ""), markup_percent: markup, price: custom, is_new: !existing });
            }
            return {
              service_id, provider,
              name: String((s as any).name ?? ""),
              category: String((s as any).category ?? ""),
              platform,
              min_quantity: Number((s as any).min ?? 1),
              max_quantity: Number((s as any).max ?? 100000),
              base_price_per_1000: priceLocal,
              custom_price_per_1000: custom,
              markup_percent: markup,
              auto_markup: autoMk,
              active: true,
              raw: s,
            };
          });
          const { error } = await db.from("smm_services").upsert(rows, { onConflict: "service_id,provider" });
          if (error) throw error;
          synced += rows.length;
        }

        if (services.length < pageSizeProv) { hasMore = false; break; }
        page += 1;
        if (Date.now() - startedAt > BUDGET_MS) { hasMore = true; break; }
      }

      const now = new Date().toISOString();

      // Purge anything outside the allowed platforms / blocked niches so the
      // catalog only ever contains services we want to sell.
      const allowedFilter = `(${ALLOWED_PLATFORMS.map((p) => `"${p}"`).join(",")})`;
      let removed = 0;
      const { data: badRows } = await db.from("smm_services")
        .select("id").not("platform", "in", allowedFilter).limit(5000);
      const badIds = (badRows ?? []).map((r: any) => r.id);
      for (let i = 0; i < badIds.length; i += 500) {
        const { error } = await db.from("smm_services").delete().in("id", badIds.slice(i, i + 500));
        if (!error) removed += Math.min(500, badIds.length - i);
      }
      for (const term of ["financial", "crypto", "forex", "loan", "casino", "bet", "adult"]) {
        await db.from("smm_services").update({ active: false })
          .or(`name.ilike.%${term}%,category.ilike.%${term}%`);
      }

      if (!hasMore) await db.from("site_settings").upsert({ key: "smm_last_sync_at", value: { at: now } });

      const { count: dbTotal } = await db.from("smm_services")
        .select("id", { count: "exact", head: true }).eq("active", true);

      return json({
        ok: true, checked, synced, added, updated, removed, skipped,
        defaultMarkup, lastSyncAt: now, hasMore, nextPage: hasMore ? page : null,
        dbTotal: dbTotal ?? null,
        withoutCustomCount: withoutCustom.length,
        withoutCustom: withoutCustom.slice(0, 200),
      });

    }



    if (action === "smm-update-service") {
      const id = String(body.id);
      const { data: svc } = await db.from("smm_services").select("*").eq("id", id).maybeSingle();
      if (!svc) return json({ ok: false, error: "Not found" });
      const patch: any = {};
      if (body.active !== undefined) patch.active = !!body.active;
      if (body.auto_markup !== undefined) patch.auto_markup = !!body.auto_markup;
      if (body.markup_percent !== undefined) patch.markup_percent = Number(body.markup_percent);
      if (body.custom_price_per_1000 !== undefined) patch.custom_price_per_1000 = Number(body.custom_price_per_1000);
      const nextAuto = body.auto_markup ?? svc.auto_markup;
      const nextMarkup = body.markup_percent ?? Number(svc.markup_percent ?? 0);
      if (nextAuto && body.custom_price_per_1000 === undefined) {
        patch.custom_price_per_1000 = Math.round(Number(svc.base_price_per_1000) * (1 + Number(nextMarkup) / 100) * 10000) / 10000;
      }
      await db.from("smm_services").update(patch).eq("id", id);
      return json({ ok: true });
    }

    if (action === "smm-set-global-markup") {
      const markup = Number(body.markup_percent);
      if (!Number.isFinite(markup)) return json({ ok: false, error: "Invalid markup" });
      // Remember it so newly synced services get this margin automatically.
      await db.from("site_settings").upsert({ key: "smm_default_markup", value: { percent: markup } });
      // Fetch ALL services in pages of 1000 (PostgREST default cap)
      const all: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data: pageRows, error: pErr } = await db.from("smm_services")
          .select("id, base_price_per_1000")
          .range(from, from + pageSize - 1);
        if (pErr) return json({ ok: false, error: pErr.message });
        const rows = pageRows ?? [];
        all.push(...rows);
        if (rows.length < pageSize) break;
        from += pageSize;
      }
      // Group services by base price so we can update thousands in one query per group.
      const groups = new Map<number, string[]>();
      for (const s of all) {
        const base = Number(s.base_price_per_1000);
        const custom = Math.round(base * (1 + markup / 100) * 10000) / 10000;
        const arr = groups.get(custom) ?? [];
        arr.push(s.id);
        groups.set(custom, arr);
      }
      let updated = 0;
      const entries = [...groups.entries()];
      const conc = 8;
      for (let i = 0; i < entries.length; i += conc) {
        const chunk = entries.slice(i, i + conc);
        const res = await Promise.all(chunk.map(async ([custom, ids]) => {
          // Chunk each group's ids into batches of 500 so the URL stays under limits.
          let n = 0;
          for (let j = 0; j < ids.length; j += 500) {
            const slice = ids.slice(j, j + 500);
            const { error } = await db.from("smm_services")
              .update({ markup_percent: markup, custom_price_per_1000: custom, auto_markup: true })
              .in("id", slice);
            if (!error) n += slice.length;
          }
          return n;
        }));
        updated += res.reduce((a, b) => a + b, 0);
      }
      return json({ ok: true, updated, total: all.length });
    }

    if (action === "smm-list-orders") {
      const search = String(body.search || "").trim();
      const status = String(body.status || "").trim();
      const pageSize = 1000;
      const rows: any[] = [];
      for (let from = 0; from < 100000; from += pageSize) {
        let q = db.from("smm_orders").select("*").order("created_at", { ascending: false })
          .range(from, from + pageSize - 1);
        if (status && status !== "all") {
          if (status === "failed") q = q.in("status", ["failed", "refunded"]);
          else q = q.eq("status", status);
        }
        if (search) q = q.or(`link.ilike.%${search}%,service_name.ilike.%${search}%,platform.ilike.%${search}%,provider_order_id.ilike.%${search}%`);
        const { data, error } = await q;
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
      }
      const userIds = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));
      const pmap: Record<string, any> = {};
      for (let i = 0; i < userIds.length; i += 500) {
        const slice = userIds.slice(i, i + 500);
        const { data: profs } = await db.from("profiles").select("id, username, full_name, email, phone").in("id", slice);
        for (const p of profs ?? []) pmap[p.id] = p;
      }
      return json({ ok: true, rows: rows.map((r: any) => ({ ...r, user: pmap[r.user_id] ?? null })) });
    }


    if (action === "smm-sync-orders") {
      const { data: pending } = await db.from("smm_orders").select("*")
        .in("status", ["pending", "processing"]).order("created_at", { ascending: false }).limit(1000);
      let updated = 0;
      for (const o of pending ?? []) {
        if (!o.provider_order_id) continue;
        try {
          const res: any = await smmOrderStatus(o.provider_order_id);
          const d = res?.data?.order ?? res?.data ?? res ?? {};
          const raw = String(d?.status ?? res?.status ?? "").toLowerCase();
          let next: string | null = null;
          if (["completed", "success", "done"].includes(raw)) next = "completed";
          else if (raw === "partial") next = "partial";
          else if (["refunded", "refund", "reversed", "cancelled", "canceled"].includes(raw)) next = "refunded";
          else if (
            ["failed", "error", "rejected", "declined"].includes(raw) ||
            (raw.startsWith("api_") && raw !== "api_pending") ||
            raw.includes("insufficient")
          ) next = "refunded";
          else if (["processing", "in progress", "in_progress", "inprogress", "active"].includes(raw)) next = "processing";
          else if (["pending", "queued", "waiting", "api_pending"].includes(raw)) next = "pending";
          if (!next || next === o.status) continue;
          const startCount = d?.start_count ?? null;
          const remainsRaw = d?.remains ?? null;
          const patch: Record<string, unknown> = { status: next, raw: res };
          if (startCount != null && Number.isFinite(Number(startCount))) patch.start_count = Number(startCount);
          if (remainsRaw != null && Number.isFinite(Number(remainsRaw))) patch.remains = Number(remainsRaw);
          else if (next === "completed") patch.remains = 0;
          await db.from("smm_orders").update(patch).eq("id", o.id);
          updated++;
          if ((next === "failed" || next === "refunded") && !["failed", "refunded"].includes(String(o.status))) {
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

    if (action === "smm-summary") {
      let apiBalance: any = null; let apiError: string | null = null;
      try { apiBalance = await smmGetBalance(); } catch (e: any) { apiError = String(e?.message || e); }
      const [ordersAll, ordersDone] = await Promise.all([
        db.from("smm_orders").select("amount_charged,profit,status", { count: "exact" }),
        db.from("smm_orders").select("profit").in("status", ["completed", "partial", "processing"]),
      ]);
      const totalProfit = (ordersDone.data ?? []).reduce((s: number, r: any) => s + Number(r.profit || 0), 0);
      const totalRevenue = (ordersAll.data ?? []).reduce((s: number, r: any) => s + Number(r.amount_charged || 0), 0);
      return json({
        ok: true,
        apiBalance, apiError,
        totalOrders: ordersAll.count ?? 0,
        totalProfit: Math.round(totalProfit * 100) / 100,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        platforms: ALLOWED_PLATFORMS,
      });
    }

    if (action === "bulk-update-orders") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const status = String(body.status || "");
      if (!ids.length) return json({ ok: false, error: "No orders selected" });
      if (!["pending", "processing", "completed", "failed", "refunded"].includes(status)) return json({ ok: false, error: "Invalid status" });
      const { data: existing } = await db.from("orders").select("id,user_id,amount_charged,status,api_reference,plan_name,network").in("id", ids);
      let refunded = 0;
      for (const o of existing ?? []) {
        if ((status === "failed" || status === "refunded") && o.status !== "failed" && o.status !== "refunded") {
          const { data: w } = await db.from("wallets").select("balance").eq("user_id", o.user_id).maybeSingle();
          const nb = Math.round((Number(w?.balance ?? 0) + Number(o.amount_charged)) * 100) / 100;
          await db.from("wallets").update({ balance: nb }).eq("user_id", o.user_id);
          await db.from("transactions").insert({
            user_id: o.user_id, type: "refund", amount: Number(o.amount_charged),
            balance_after: nb, reference: o.api_reference,
            description: `Refund: ${o.plan_name} (${o.network})`, meta: { order_id: o.id, source: "admin_bulk" },
          });
          refunded++;
        }
      }
      await db.from("orders").update({ status }).in("id", ids);
      return json({ ok: true, updated: ids.length, refunded });
    }

    if (action === "delete-orders") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (!ids.length) return json({ ok: false, error: "No orders selected" });
      const { data: existing } = await db.from("orders").select("id,user_id,amount_charged,status,api_reference,plan_name,network").in("id", ids);
      let refunded = 0;
      for (const o of existing ?? []) {
        if (o.status !== "failed" && o.status !== "refunded" && o.status !== "completed") {
          const { data: w } = await db.from("wallets").select("balance").eq("user_id", o.user_id).maybeSingle();
          const nb = Math.round((Number(w?.balance ?? 0) + Number(o.amount_charged)) * 100) / 100;
          await db.from("wallets").update({ balance: nb }).eq("user_id", o.user_id);
          await db.from("transactions").insert({
            user_id: o.user_id, type: "refund", amount: Number(o.amount_charged),
            balance_after: nb, reference: o.api_reference,
            description: `Refund on delete: ${o.plan_name} (${o.network})`, meta: { order_id: o.id, source: "admin_delete" },
          });
          refunded++;
        }
      }
      await db.from("orders").delete().in("id", ids);
      return json({ ok: true, deleted: ids.length, refunded });
    }

    if (action === "export-user-orders") {
      const userIds: string[] = Array.isArray(body.user_ids) ? body.user_ids.map(String) : [];
      const from = body.from ? String(body.from) : null;
      const to = body.to ? String(body.to) : null;
      const status = body.status ? String(body.status) : null;
      if (!userIds.length) return json({ ok: false, error: "No users selected" });
      let q = db.from("orders").select("user_id,phone,plan_name,network,status,amount_charged,created_at")
        .in("user_id", userIds).order("created_at", { ascending: false }).limit(5000);
      if (from) q = q.gte("created_at", from);
      if (to) q = q.lte("created_at", to);
      if (status && status !== "all") q = q.eq("status", status);
      const { data } = await q;
      return json({ ok: true, rows: data ?? [] });
    }

    // ============ BUSINESS HOURS ============
    if (action === "get-business-hours") {
      const { data } = await db.from("site_settings").select("key,value").in("key", [
        "business_open_time","business_close_time","business_auto_schedule",
        "business_manual_state","settlement_reminder_minutes",
      ]);
      const m: Record<string, unknown> = {};
      for (const r of (data ?? [])) m[r.key] = r.value;
      return json({ ok: true, settings: m });
    }
    if (action === "set-business-hours") {
      const updates: Array<[string, unknown]> = [];
      if (typeof body.open_time === "string") updates.push(["business_open_time", body.open_time]);
      if (typeof body.close_time === "string") updates.push(["business_close_time", body.close_time]);
      if (typeof body.auto_schedule === "boolean") updates.push(["business_auto_schedule", body.auto_schedule]);
      if (body.manual_state === "open" || body.manual_state === "closed" || body.manual_state === "auto") {
        updates.push(["business_manual_state", body.manual_state]);
      }
      if (typeof body.reminder_minutes === "number") updates.push(["settlement_reminder_minutes", body.reminder_minutes]);
      for (const [k, v] of updates) {
        await db.from("site_settings").upsert({ key: k, value: v }, { onConflict: "key" });
      }
      return json({ ok: true });
    }

    // ============ AGENT CREDIT ACCOUNTS ============
    if (action === "list-agents-credit") {
      const search = String(body.search || "").toLowerCase();
      const { data: agents } = await db.from("agents").select("user_id, store_name");
      const ids = (agents ?? []).map((a: any) => a.user_id);
      if (ids.length === 0) return json({ ok: true, rows: [] });
      const { data: profiles } = await db.from("profiles").select("id, full_name, username, phone, email").in("id", ids);
      const { data: credits } = await db.from("agent_credit").select("*").in("agent_id", ids);
      const pMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const cMap = new Map((credits ?? []).map((c: any) => [c.agent_id, c]));
      let rows = (agents ?? []).map((a: any) => {
        const p: any = pMap.get(a.user_id) ?? {};
        const c: any = cMap.get(a.user_id) ?? { enabled: false, credit_limit: 0, outstanding: 0 };
        return {
          agent_id: a.user_id, store_name: a.store_name,
          full_name: p.full_name, username: p.username, phone: p.phone, email: p.email,
          enabled: !!c.enabled, credit_limit: Number(c.credit_limit ?? 0), outstanding: Number(c.outstanding ?? 0),
          last_settled_at: c.last_settled_at ?? null,
        };
      });
      if (search) {
        rows = rows.filter((r: any) =>
          (r.username ?? "").toLowerCase().includes(search) ||
          (r.full_name ?? "").toLowerCase().includes(search) ||
          (r.email ?? "").toLowerCase().includes(search) ||
          (r.phone ?? "").toLowerCase().includes(search) ||
          (r.store_name ?? "").toLowerCase().includes(search));
      }
      return json({ ok: true, rows });
    }
    if (action === "set-agent-credit") {
      const agent_id = String(body.agent_id || "");
      if (!agent_id) return json({ ok: false, error: "Missing agent" });
      const patch: Record<string, unknown> = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.credit_limit === "number") patch.credit_limit = body.credit_limit;
      const { data: exists } = await db.from("agent_credit").select("agent_id").eq("agent_id", agent_id).maybeSingle();
      if (exists) {
        await db.from("agent_credit").update(patch).eq("agent_id", agent_id);
      } else {
        await db.from("agent_credit").insert({ agent_id, ...patch });
      }
      return json({ ok: true });
    }
    if (action === "clear-agent-credit") {
      const agent_id = String(body.agent_id || "");
      if (!agent_id) return json({ ok: false, error: "Missing agent" });
      await db.from("agent_credit").update({ outstanding: 0, last_settled_at: new Date().toISOString() }).eq("agent_id", agent_id);
      await db.from("credit_orders_log").update({ settled: true, settled_at: new Date().toISOString(), settlement_reference: "ADMIN-CLEAR" })
        .eq("agent_id", agent_id).eq("settled", false);
      return json({ ok: true });
    }

    if (action === "list-agents-balances") {
      const search = String(body.search || "").toLowerCase().trim();
      const { data: agents, error: aErr } = await db.from("agents")
        .select("user_id, store_name, active, profit_balance, activated_at, created_at")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (aErr) return json({ ok: false, error: aErr.message });
      const ids = (agents ?? []).map((a: any) => a.user_id);
      if (ids.length === 0) return json({ ok: true, rows: [] });
      const { data: profiles, error: pErr } = await db.from("profiles")
        .select("id, username, email, phone, full_name")
        .in("id", ids);
      if (pErr) return json({ ok: false, error: pErr.message });
      const pMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      let rows = (agents ?? []).map((a: any) => ({
        ...a,
        profiles: pMap.get(a.user_id) ?? null,
      }));
      if (search) {
        rows = rows.filter((r: any) => {
          const p = r.profiles ?? {};
          return String(r.store_name ?? "").toLowerCase().includes(search) ||
            String(p.username ?? "").toLowerCase().includes(search) ||
            String(p.full_name ?? "").toLowerCase().includes(search) ||
            String(p.email ?? "").toLowerCase().includes(search) ||
            String(p.phone ?? "").toLowerCase().includes(search);
        });
      }
      return json({ ok: true, rows });
    }

    if (action === "adjust-agent-balance") {
      const agent_id = String(body.agent_id || "");
      const amount = Number(body.amount);
      const type = String(body.type || "credit"); // credit | debit
      const note = String(body.note || "").trim();
      if (!agent_id) return json({ ok: false, error: "Missing agent" });
      if (!Number.isFinite(amount) || amount <= 0) return json({ ok: false, error: "Invalid amount" });
      const { data: ag } = await db.from("agents").select("profit_balance").eq("user_id", agent_id).maybeSingle();
      if (!ag) return json({ ok: false, error: "Agent not found" });
      const cur = Number(ag.profit_balance ?? 0);
      const delta = type === "credit" ? amount : -amount;
      const next = Math.round((cur + delta) * 100) / 100;
      if (next < 0) return json({ ok: false, error: "Insufficient profit balance" });
      await db.from("agents").update({ profit_balance: next }).eq("user_id", agent_id);
      await db.from("transactions").insert({
        user_id: agent_id,
        type: type === "credit" ? "agent_profit_credit" : "agent_profit_debit",
        amount: delta,
        balance_after: next,
        description: note || (type === "credit" ? "Admin credit to agent profit" : "Admin debit from agent profit"),
      });
      return json({ ok: true, profit_balance: next });
    }

    return json({ ok: false, error: "Unknown action" }, { status: 400 });


  } catch (e) {
    console.error("[admin] error:", e);
    return json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
});
