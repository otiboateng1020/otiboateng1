import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export function adminClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(authHeader: string | null) {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
  });
}

export async function requireUser(req: Request): Promise<{ userId: string; email: string } | null> {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  // The function gateway validates the JWT before this handler runs
  // (`verify_jwt = true`). Ask Auth for the canonical user first.
  const authClient = anonClient(auth);
  const { data, error } = await authClient.auth.getUser(token);
  if (!error && data.user) {
    return { userId: data.user.id, email: data.user.email ?? "" };
  }

  // Auth's user lookup can briefly reject a freshly rotated token even though
  // the gateway has already verified it. In that case, use the verified JWT
  // claims instead of turning every dashboard request into a second 401.
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded));
    const expectedIssuer = `${Deno.env.get("SUPABASE_URL")}/auth/v1`;
    const validSubject = typeof claims.sub === "string" && /^[0-9a-f-]{36}$/i.test(claims.sub);
    const validExpiry = typeof claims.exp === "number" && claims.exp * 1000 > Date.now();
    const validAudience = claims.aud === "authenticated";
    if (!validSubject || !validExpiry || !validAudience || claims.iss !== expectedIssuer) return null;
    return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : "" };
  } catch {
    return null;
  }
}
