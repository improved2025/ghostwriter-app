// /api/paypal-capture-order.js
// Captures a PayPal order, then upgrades the user's plan in Supabase usage_limits.
// Requires logged-in user.

import { createClient } from "@supabase/supabase-js";

const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function paypalBase() {
  return PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function basicAuth() {
  const raw = `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`;
  return Buffer.from(raw).toString("base64");
}

function extractAccessToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/Bearer\s+(.+)/i);
  if (m?.[1]) return m[1].trim();

  const cookie = req.headers.cookie || "";
  const sbAccess = cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
  if (sbAccess?.[1]) return decodeURIComponent(sbAccess[1]);

  return null;
}

async function requireUserId(req) {
  const token = extractAccessToken(req);
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;

  const authed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const u = await authed.auth.getUser();
  return u?.data?.user?.id || null;
}

function clean(v) {
  return (v ?? "").toString().trim().toLowerCase();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    if (!PAYPAL_CLIENT_ID) return res.status(500).json({ error: "Missing PAYPAL_CLIENT_ID" });
    if (!PAYPAL_CLIENT_SECRET) return res.status(500).json({ error: "Missing PAYPAL_CLIENT_SECRET" });
    if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const userId = await requireUserId(req);
    if (!userId) return res.status(401).json({ error: "not_authenticated" });

    const orderID = (req.body?.orderID || "").toString().trim();
    if (!orderID) return res.status(400).json({ error: "missing_orderID" });

    // Capture payment
    const resp = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        "Content-Type": "application/json",
      },
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return res.status(500).json({ error: "paypal_capture_failed", details: data });
    }

    // Determine plan from purchase_units description (simple + works with our create order)
    const desc = clean(data?.purchase_units?.[0]?.description || "");
    const plan = desc.includes("lifetime") ? "lifetime" : "project";

    // Upgrade user in usage_limits table
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const up = await supabaseAdmin
      .from("usage_limits")
      .upsert(
        { user_id: userId, plan, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );

    if (up.error) {
      return res.status(500).json({ error: "upgrade_failed", details: up.error.message });
    }

    return res.status(200).json({ ok: true, plan });
  } catch (err) {
    return res.status(500).json({ error: "server_error", details: String(err?.message || err) });
  }
}
