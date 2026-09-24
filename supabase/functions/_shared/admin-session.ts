import { adminClient } from "./admin.ts";
import { hashCode } from "./code.ts";

const SESSION_TTL_MIN = 60 * 8; // 8 hours

export async function mintAdminSession(): Promise<string> {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const token = Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
  const token_hash = await hashCode(token);
  const expires_at = new Date(Date.now() + SESSION_TTL_MIN * 60_000).toISOString();
  const db = adminClient();
  await db.from("admin_sessions").insert({ token_hash, expires_at });
  return token;
}

export async function verifyAdminToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  const token_hash = await hashCode(token);
  const db = adminClient();
  const { data } = await db
    .from("admin_sessions")
    .select("id,expires_at")
    .eq("token_hash", token_hash)
    .maybeSingle();
  if (!data) return false;
  return new Date(data.expires_at).getTime() > Date.now();
}

export async function clearAdminToken(token: string | null) {
  if (!token) return;
  const token_hash = await hashCode(token);
  const db = adminClient();
  await db.from("admin_sessions").delete().eq("token_hash", token_hash);
}
