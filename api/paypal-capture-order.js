// /api/paypal-capture-order.js
// Captures PayPal order, then activates plan.
// Requires Authorization: Bearer <supabase_access_token>
// Body: { orderID: "..." }
// Returns: { ok: true }

import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./_supabase.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();

function extractAccessToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/Bearer\s+(.+)/i);
  return m?.[1] ? m[1].trim() : null;
}

async function getUserIdFromRequest(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const token = extractAccessToken(req);
  if (!token) return null;

  const authed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const u = await authed.auth.getUser();
  return u?.data?.user?.id || null;
}

function paypalBase() {
  return PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function getPayPalAccessToken() {
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const resp = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(data?.error_description || "paypal_oauth_failed");
  }
  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      return res.status(500).json({ error: "Missing PayPal env vars" });
    }

    const userId = await getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "not_authenticated" });

    const orderID = (req.body?.orderID || "").toString().trim();
    if (!orderID) return res.status(400).json({ error: "missing_orderID" });

    const ppToken = await getPayPalAccessToken();

    // Capture
    const capResp = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ppToken}`,
        "Content-Type": "application/json"
      }
    });

    const cap = await capResp.json().catch(() => ({}));
    if (!capResp.ok) return res.status(500).json({ error: "paypal_capture_failed", details: cap });

    // Figure out plan from reference_id we set during create
    const ref = cap?.purchase_units?.[0]?.reference_id || "";
    const plan = ref.includes("lifetime") ? "lifetime" : "project";

    // Safety: ensure order custom_id matches this logged-in user
    const customId = cap?.purchase_units?.[0]?.custom_id || "";
    if (customId && customId !== userId) {
      return res.status(403).json({ error: "order_user_mismatch" });
    }

    // Activate plan in DB
    const sb = supabaseAdmin();
    const up = await sb
      .from("usage_limits")
      .upsert(
        { user_id: userId, plan, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );

    if (up.error) return res.status(500).json({ error: "unlock_failed", details: up.error.message });

    return res.status(200).json({ ok: true, plan });
  } catch (err) {
    return res.status(500).json({ error: "server_error", details: String(err?.message || err) });
  }
}
