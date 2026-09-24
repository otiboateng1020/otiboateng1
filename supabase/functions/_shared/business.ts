// deno-lint-ignore-file no-explicit-any
// Business hours + agent credit helpers (Africa/Accra, UTC+0, no DST).

export interface BusinessSettings {
  open: string;   // "HH:MM"
  close: string;  // "HH:MM"
  auto: boolean;
  manual: "open" | "closed" | "auto";
  reminderMinutes: number;
}

export async function getBusinessSettings(db: any): Promise<BusinessSettings> {
  const { data } = await db.from("site_settings").select("key,value").in("key", [
    "business_open_time", "business_close_time",
    "business_auto_schedule", "business_manual_state",
    "settlement_reminder_minutes",
  ]);
  const m = new Map<string, any>((data ?? []).map((r: any) => [r.key, r.value]));
  const rd = (k: string, d: any) => {
    const v = m.get(k);
    return v === undefined || v === null ? d : v;
  };
  return {
    open: String(rd("business_open_time", "08:00")),
    close: String(rd("business_close_time", "22:00")),
    auto: rd("business_auto_schedule", false) === true || rd("business_auto_schedule", false) === "true",
    manual: (String(rd("business_manual_state", "open")) as any),
    reminderMinutes: Number(rd("settlement_reminder_minutes", 60)) || 60,
  };
}

function toMin(hhmm: string): number {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function nowGhMin(): number {
  // Africa/Accra = UTC+0
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function computeStatus(s: BusinessSettings) {
  const nowM = nowGhMin();
  const openM = toMin(s.open);
  const closeM = toMin(s.close);
  let open: boolean;
  if (s.manual === "open") open = true;
  else if (s.manual === "closed") open = false;
  else {
    // manual === "auto" → always follow the schedule window
    open = openM <= closeM
      ? (nowM >= openM && nowM < closeM)
      : (nowM >= openM || nowM < closeM); // overnight window
  }
  const minutesToClose = open ? (closeM >= nowM ? closeM - nowM : (24 * 60 - nowM) + closeM) : 0;
  return { open, minutesToClose, openTime: s.open, closeTime: s.close };
}

// Per-store (agent) hours. Same semantics as the platform-wide settings:
// mode "open" = always open, "closed" = force closed, "auto" = follow the window.
export function computeStoreStatus(openTime?: string | null, closeTime?: string | null, mode?: string | null) {
  const open_ = String(openTime || "08:00");
  const close_ = String(closeTime || "22:00");
  const m = ["open", "auto", "closed"].includes(String(mode)) ? String(mode) : "open";
  const nowM = nowGhMin();
  const openM = toMin(open_);
  const closeM = toMin(close_);
  let open: boolean;
  if (m === "open") open = true;
  else if (m === "closed") open = false;
  else open = openM <= closeM ? (nowM >= openM && nowM < closeM) : (nowM >= openM || nowM < closeM);
  const minutesToClose = open ? (closeM >= nowM ? closeM - nowM : (24 * 60 - nowM) + closeM) : 0;
  return { open, minutesToClose, openTime: open_, closeTime: close_, mode: m };
}

// ---- Platform-wide payment switch (mobile-money in) ----
export const PAYMENTS_CLOSED_DEFAULT = "Payment closed, will be back shortly.";

export async function getPaymentSettings(db: any): Promise<{ enabled: boolean; message: string }> {
  const { data } = await db.from("site_settings").select("value").eq("key", "payments_enabled").maybeSingle();
  const v = (data?.value ?? null) as any;
  if (v === null || v === undefined) return { enabled: true, message: PAYMENTS_CLOSED_DEFAULT };
  if (typeof v === "boolean") return { enabled: v, message: PAYMENTS_CLOSED_DEFAULT };
  return {
    enabled: v.enabled !== false,
    message: String(v.message || "").trim() || PAYMENTS_CLOSED_DEFAULT,
  };
}
