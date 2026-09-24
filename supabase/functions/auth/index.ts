// deno-lint-ignore-file no-explicit-any
import { adminClient } from "../_shared/admin.ts";
import { json, handleOptions } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  try {
    const body = await req.json();
    const action = String(body.action || "");
    const db = adminClient();

    if (action === "check-username") {
      const username = String(body.username || "").trim();
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
        return json({ available: false, error: "Invalid username" });
      const { data } = await db.from("profiles").select("id").ilike("username", username).limit(1);
      return json({ available: !data || data.length === 0 });
    }

    if (action === "signup-request" || action === "signup") {
      const { full_name, username, phone, email, password, referral_code } = body;
      if (!full_name || !username || !phone || !email || !password)
        return json({ ok: false, error: "Missing fields" });
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(username))
        return json({ ok: false, error: "Invalid username" });
      if (String(password).length < 6)
        return json({ ok: false, error: "Password too short" });
      const { data: existsUn } = await db.from("profiles").select("id").ilike("username", username).limit(1);
      if (existsUn && existsUn.length) return json({ ok: false, error: "Username taken" });
      const { data: existsEm } = await db.from("profiles").select("id").eq("email", String(email).toLowerCase()).limit(1);
      if (existsEm && existsEm.length) return json({ ok: false, error: "Email already registered" });

      const { data: created, error } = await db.auth.admin.createUser({
        email: String(email).trim().toLowerCase(),
        password: String(password),
        email_confirm: true,
        user_metadata: {
          full_name,
          username,
          phone,
          referred_by_code: referral_code ?? "",
        },
      });
      if (error) {
        const msg = /duplicate|unique|already/i.test(error.message)
          ? "Username or email already registered"
          : error.message;
        return json({ ok: false, error: msg });
      }
      return json({ ok: true, userId: created.user?.id ?? null, email: String(email).trim().toLowerCase() });
    }

    if (action === "login-request" || action === "login") {
      const identifier = String(body.email || "").trim();
      const password = String(body.password || "");
      if (!identifier || !password) return json({ ok: false, error: "Missing credentials" });
      let email = identifier.toLowerCase();
      if (!identifier.includes("@")) {
        const { data: prof0 } = await db.from("profiles").select("email").eq("username", identifier.toLowerCase()).maybeSingle();
        if (!prof0?.email) return json({ ok: false, error: "Invalid credentials" });
        email = String(prof0.email).toLowerCase();
      }
      const url = Deno.env.get("SUPABASE_URL")!;
      const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
      const check = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` },
        body: JSON.stringify({ email, password }),
      });
      if (!check.ok) return json({ ok: false, error: "Invalid credentials" });
      const authJson = await check.json();
      const uid = authJson?.user?.id;
      const { data: prof } = await db.from("profiles").select("is_banned").eq("id", uid).maybeSingle();
      if (prof?.is_banned) return json({ ok: false, error: "This account is banned. Contact support." });

      const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: "magiclink", email });
      if (lErr || !link?.properties)
        return json({ ok: false, error: lErr?.message || "Failed to create session" });
      return json({ ok: true, email, token_hash: link.properties.hashed_token });
    }

    if (action === "reset-request" || action === "reset-verify") {
      return json({ ok: false, error: "Password reset is handled by support. Please contact us." });
    }

    return json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[auth] error:", e);
    return json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
});
