// BWM XMD social-media boosting API client.
// Base: https://xmdapis.bwmxmd.co.ke/api   Auth: Authorization: Bearer <BWMXMD_API_KEY>
// Kept under the old filename so every call site keeps working unchanged.
const BASE = (Deno.env.get("BWMXMD_BASE_URL") || "https://xmdapis.bwmxmd.co.ke/api").replace(/\/+$/, "");
const CURRENCY = Deno.env.get("BWMXMD_CURRENCY") || "GHS";

// Platforms we surface to end users. Order matters: more-specific labels first
// so "Threads" doesn't get eaten by "Instagram".
export const ALLOWED_PLATFORMS = [
  "TikTok", "Instagram", "Facebook", "YouTube", "Twitter", "Telegram",
  "WhatsApp", "Spotify", "Threads",
] as const;

const PLATFORM_ALIASES: Array<[RegExp, string]> = [
  [/\bthreads\b/i, "Threads"],
  [/\bwhats\s*app\b|\bwhatsapp\b/i, "WhatsApp"],
  [/\btiktok\b|\btik\s*tok\b/i, "TikTok"],
  [/\byoutube\b|\byt\b/i, "YouTube"],
  [/\btelegram\b|\btg\b/i, "Telegram"],
  [/\bspotify\b/i, "Spotify"],
  [/\btwitter\b|\bx\s*\(twitter\)|\(twitter\s*\/\s*x\)|^x\s|\stweet/i, "Twitter"],
  [/\binstagram\b|\binsta\b/i, "Instagram"],
  [/\bfacebook\b|\bfb\b/i, "Facebook"],
];

export function normalizePlatform(category: string | null | undefined, name?: string): string | null {
  const cat = String(category ?? "");
  for (const [re, label] of PLATFORM_ALIASES) if (re.test(cat)) return label;
  const alt = String(name ?? "");
  if (alt) for (const [re, label] of PLATFORM_ALIASES) if (re.test(alt)) return label;
  return null;
}

const SUBCATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/\bwatch\s*(?:time|hours?)\b/i, "Watch Hours"],
  [/\bfollowers?\b|\bmembers?\b/i, "Followers/Members"],
  [/\bsubscribers?\b/i, "Subscribers"],
  [/\b(?:reactions?|emoji|emojis)\b/i, "Reactions"],
  [/\blikes?\b/i, "Likes"],
  [/\b(?:views?|plays?)\b/i, "Views"],
  [/\bcomments?\b/i, "Comments"],
  [/\bshares?\b/i, "Shares"],
  [/\bsaves?\b/i, "Saves"],
  [/\blisteners?\b/i, "Listeners"],
  [/\breposts?\b/i, "Reposts"],
  [/\bstreams?\b/i, "Streams"],
  [/\blive\b/i, "Live"],
  [/\bmonetization\b/i, "Monetization"],
  [/\bpost(?:s|ing)?\b/i, "Posts"],
];

export function getSubcategory(category: string | null | undefined, name?: string | null): string {
  const hay = `${category ?? ""} ${name ?? ""}`;
  for (const [re, label] of SUBCATEGORY_KEYWORDS) if (re.test(hay)) return label;
  return "Other";
}

function key() {
  const k = Deno.env.get("BWMXMD_API_KEY") || Deno.env.get("NETWAVE_API_KEY");
  if (!k) throw new Error("BWMXMD_API_KEY not configured");
  return k;
}

/** Marker used everywhere to recognise "our provider wallet is empty". */
export const PROVIDER_INSUFFICIENT = "PROVIDER_INSUFFICIENT";

export function isProviderInsufficient(err: unknown) {
  const m = String((err as any)?.message ?? err ?? "").toLowerCase();
  return m.includes("provider_insufficient") ||
    m.includes("insufficient") ||
    m.includes("not enough") ||
    m.includes("top up") ||
    m.includes("topup");
}

async function req(path: string, init: RequestInit = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key()}`,
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let j: any;
    try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!res.ok || j?.success === false) {
      const msg = String(j?.error || j?.message || text.slice(0, 300));
      // 402 = provider wallet empty (documented by BWM XMD).
      if (res.status === 402 || /insufficient|not enough/i.test(msg)) {
        throw new Error(`${PROVIDER_INSUFFICIENT}: ${msg}`);
      }
      throw new Error(msg);
    }
    return j;
  } finally {
    clearTimeout(t);
  }
}

export const PROVIDER = "bwmxmd";

/** XD → local (GHS) rate, derived from any priced service row. */
/**
 * XD -> local (GHS) rate straight from the provider's own currency service.
 * `/currency/rates` gives `xd_per_unit` (XD needed for 1 GHS), so the rate we
 * want is 1 / xd_per_unit. Cached for 5 minutes as the docs recommend.
 */
let rateCache: { rate: number; at: number } | null = null;

async function xdToLocalRate(): Promise<number | null> {
  if (rateCache && Date.now() - rateCache.at < 5 * 60 * 1000) return rateCache.rate;
  try {
    const j = await req(`/currency/rates`);
    const rows: any[] = j?.data?.currencies ?? [];
    const row = rows.find((c) => String(c?.currency ?? "").toUpperCase() === CURRENCY.toUpperCase());
    const perUnit = Number(row?.xd_per_unit ?? 0);
    if (perUnit > 0) {
      const rate = 1 / perUnit;
      rateCache = { rate, at: Date.now() };
      return rate;
    }
  } catch { /* fall through to convert */ }
  try {
    const j = await req(`/currency/convert`, {
      method: "POST",
      body: JSON.stringify({ amount: 1000, from: "XD", to: CURRENCY }),
    });
    const result = Number(j?.data?.result ?? 0);
    if (result > 0) {
      const rate = result / 1000;
      rateCache = { rate, at: Date.now() };
      return rate;
    }
  } catch { /* ignore */ }
  return null;
}

export async function getBalance() {
  const j = await req(`/account/balance`);
  const d = j?.data ?? j ?? {};
  const xd = Number(d?.wallet_balance_xd ?? d?.balance ?? 0);
  const rate = await xdToLocalRate();
  return {
    wallet_balance_xd: xd,
    referral_balance_xd: Number(d?.referral_balance_xd ?? 0),
    rate,
    currency: CURRENCY,
    wallet_balance_local: rate != null ? Math.round(xd * rate * 100) / 100 : null,
    balance: xd,
  };
}

export async function getServicesRaw() {
  return req(`/services?limit=1&offset=0&currency=${encodeURIComponent(CURRENCY)}`);
}

function extractServices(payload: any): any[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.services)) return payload.data.services;
  if (Array.isArray(payload?.services)) return payload.services;
  if (Array.isArray(payload)) return payload;
  return [];
}

/** Normalize a BWM XMD service row into the shape the sync code expects. */
function shape(s: any) {
  const local = Number(s?.price_per_1000_local ?? 0);
  const price = local > 0
    ? local
    : Number(s?.price_per_1000_xd ?? s?.price_per_1000_ksh ?? s?.rate ?? s?.price ?? 0);
  return {
    id: Number(s?.id ?? s?.service_id),
    name: String(s?.name ?? ""),
    category: String(s?.category ?? s?.platform ?? ""),
    platform: s?.platform ?? null,
    min: Number(s?.min ?? s?.min_quantity ?? 1),
    max: Number(s?.max ?? s?.max_quantity ?? 100000),
    rate: price,
    price_per_1000: price,
    // Upstream panel id (px1 / px2 / px3) — required when placing the order.
    provider: String(s?.provider ?? PROVIDER),
    raw: s,
  };
}

async function fetchServicesPage(limit: number, offset: number) {
  const j = await req(`/services?limit=${limit}&offset=${offset}&currency=${encodeURIComponent(CURRENCY)}`);
  return extractServices(j).map(shape).filter((s) => s.id);
}

/** Walk the whole catalogue with limit/offset paging. */
export async function forEachServicesPage(
  onPage: (services: any[], page: number) => Promise<void>,
  opts: { limit?: number; maxPages?: number } = {},
) {
  const pageSize = Math.min(Math.max(Number(opts.limit ?? 500) || 500, 50), 500);
  const maxPages = Math.min(Math.max(Number(opts.maxPages ?? 60) || 60, 1), 200);
  const seen = new Set<number>();
  let total = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchServicesPage(pageSize, (page - 1) * pageSize);
    const unique = batch.filter((s) => !seen.has(s.id) && (seen.add(s.id), true));
    if (unique.length) {
      total += unique.length;
      await onPage(unique, page);
    }
    if (batch.length < pageSize || unique.length === 0) break;
  }
  return total;
}

export async function getServicesPage(page = 1, limit = 500) {
  const pageSize = Math.min(Math.max(Number(limit) || 500, 50), 500);
  const p = Math.max(1, Math.floor(Number(page) || 1));
  return fetchServicesPage(pageSize, (p - 1) * pageSize);
}

export async function getServices() {
  const all: any[] = [];
  await forEachServicesPage(async (rows) => { all.push(...rows); });
  return all;
}

export async function placeOrder(args: { service_id: number; provider?: string; link: string; quantity: number }) {
  const provider = String(args.provider ?? "").trim();
  return req(`/services/order`, {
    method: "POST",
    body: JSON.stringify({
      service_id: Number(args.service_id),
      ...(provider && provider !== PROVIDER ? { provider } : {}),
      link: args.link,
      quantity: Number(args.quantity),
    }),
  });
}

export async function getOrderStatus(id: string | number) {
  return req(`/services/order/${encodeURIComponent(String(id))}`);
}

/** Diagnostic: confirm auth + paging work and show the raw row shape. */
export async function probePages() {
  const out: any = { base: BASE, pages: [] as any[] };
  try {
    const first = await req(`/services?limit=2&offset=0`);
    out.topKeys = first && typeof first === "object" ? Object.keys(first) : [];
    out.total = first?.total ?? null;
    out.sample = extractServices(first).slice(0, 2);
  } catch (e) {
    out.error = String((e as Error).message).slice(0, 300);
    return out;
  }
  for (const q of [`limit=500&offset=0`, `limit=500&offset=500`, `limit=500&offset=1000`]) {
    try {
      const j = await req(`/services?${q}`);
      const arr = extractServices(j);
      out.pages.push({ q, count: arr.length, firstId: arr[0]?.id ?? arr[0]?.service_id ?? null });
    } catch (e) {
      out.pages.push({ q, error: String((e as Error).message).slice(0, 200) });
    }
  }
  return out;
}
