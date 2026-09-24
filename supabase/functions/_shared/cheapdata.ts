// God Is Here Prime data API client (Deno / edge functions)
// Docs: https://godishereprime.com/api-dashboard/documentation/
// Base: https://godishereprime.com/api/v1   Auth: Authorization: Bearer <GIHPRIME_API_KEY>
// Kept under the old filename so every call site keeps working unchanged.
const BASE = (Deno.env.get("GIHPRIME_BASE_URL") || "https://godishereprime.com/api/v1").replace(/\/+$/, "");

function key() {
  const k = Deno.env.get("GIHPRIME_API_KEY") || Deno.env.get("CHEAPDATA_API_KEY");
  if (!k) throw new Error("GIHPRIME_API_KEY not configured");
  return k;
}

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${key()}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!res.ok || j?.success === false) {
    const msg = typeof j?.error === "string" && j.error.trim()
      ? j.error.trim()
      : typeof j?.message === "string" && j.message.trim()
      ? j.message.trim()
      : text.slice(0, 300);
    if (res.status === 402 || /insufficient|not enough|top ?up|low balance/i.test(msg)) {
      throw new Error(`${PROVIDER_INSUFFICIENT}: ${msg}`);
    }
    throw new Error(msg);
  }
  return j;
}

/** Marker used everywhere to recognise "our data provider wallet is empty". */
export const PROVIDER_INSUFFICIENT = "PROVIDER_INSUFFICIENT";

export function isProviderInsufficient(err: unknown) {
  const m = String((err as any)?.message ?? err ?? "").toLowerCase();
  return m.includes("provider_insufficient") ||
    m.includes("insufficient") ||
    m.includes("not enough") ||
    m.includes("top up") ||
    m.includes("topup") ||
    m.includes("low balance");
}

/** The packages route has moved around between provider versions; try the known spellings once. */
const PACKAGE_PATHS = ["/packages/", "/data-packages/", "/packages"];
let packagesPath: string | null = null;

async function fetchPackagesPayload() {
  if (packagesPath) return req(packagesPath);
  let lastErr: unknown = null;
  for (const p of PACKAGE_PATHS) {
    try {
      const j = await req(p);
      packagesPath = p;
      return j;
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Could not load data packages");
}

/** Provider network keys → display names used across the app. */
export const NETWORK_DISPLAY: Record<string, string> = {
  mtn: "MTN",
  mtn_express: "MTN EXPRESS",
  telecel: "TELECEL",
  vodafone: "TELECEL",
  airteltigo: "AIRTELTIGO",
  airteltigo_ishare: "AIRTELTIGO",
  airteltigo_bigtime: "AIRTELTIGO BIGTIME",
  at: "AIRTELTIGO",
};

export function displayNetwork(raw: string) {
  const k = String(raw ?? "").trim();
  return NETWORK_DISPLAY[k] ?? NETWORK_DISPLAY[k.toLowerCase()] ?? k.replace(/_/g, " ").toUpperCase();
}

/** Legacy `network:size` plan codes are still parsed so old rows don't break. */
export function parsePlanCode(code: string | number): { network: string; amount: string } {
  const raw = String(code);
  const i = raw.indexOf(":");
  if (i === -1) return { network: "", amount: raw };
  return { network: raw.slice(0, i), amount: raw.slice(i + 1) };
}

function listOf(j: any): any[] {
  if (Array.isArray(j?.data?.packages)) return j.data.packages;
  if (Array.isArray(j?.data)) return j.data;
  if (Array.isArray(j?.packages)) return j.packages;
  if (Array.isArray(j?.results)) return j.results;
  if (Array.isArray(j)) return j;
  return [];
}

export async function getDataPackages() {
  const j = await fetchPackagesPayload();
  const out: any[] = [];
  for (const p of listOf(j)) {
    const id = String(p?.id ?? p?.package_id ?? "").trim();
    if (!id) continue;
    const networkRaw = String(p?.network ?? p?.network_key ?? p?.networkType ?? p?.network_name ?? "").trim();
    const size = String(p?.size_gb ?? p?.size ?? p?.capacity ?? p?.volume ?? "").replace(/gb/i, "").trim();
    out.push({
      id,
      network: networkRaw,
      network_display: displayNetwork(networkRaw),
      size,
      price: Number(p?.price ?? p?.agent_price ?? p?.cost ?? 0),
      validity: p?.validity ?? p?.duration ?? null,
      is_active: p?.is_active !== false && p?.in_stock !== false && p?.available !== false,
    });
  }
  return out;
}

export async function createOrder(args: { package_id: number | string; phone: string; reference?: string }) {
  const pkg = String(args.package_id);
  const package_id = /^\d+$/.test(pkg) ? Number(pkg) : pkg;
  return req(`/orders/create/`, {
    method: "POST",
    body: JSON.stringify({
      package_id,
      phone_number: args.phone,
      ...(args.reference ? { reference: args.reference } : {}),
    }),
  });
}

export async function getOrderStatus(idOrReference: string | number) {
  const v = encodeURIComponent(String(idOrReference));
  try {
    return await req(`/orders/${v}/`);
  } catch (_e) {
    return req(`/orders/?reference=${v}`);
  }
}

export async function getBalance() {
  return req(`/wallet/balance/`);
}

export async function getNetworkStatus() {
  try {
    const j = await req(`/networks/`);
    const rows = listOf(j);
    if (rows.length) {
      return rows.map((n: any) => ({
        network: displayNetwork(String(n?.network ?? n?.name ?? "")),
        available: n?.is_accepting_orders !== false && String(n?.status ?? "").toLowerCase() !== "offline",
      }));
    }
  } catch (_e) { /* fall back to package availability */ }
  const packages = await getDataPackages();
  const byNetwork = new Map<string, boolean>();
  for (const p of packages) {
    byNetwork.set(p.network_display, (byNetwork.get(p.network_display) ?? false) || p.is_active);
  }
  return Array.from(byNetwork, ([network, available]) => ({ network, available }));
}
