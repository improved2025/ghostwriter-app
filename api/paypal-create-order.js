// /api/paypal-create-order.js
// Creates a PayPal order for a plan.
// Requires Authorization: Bearer <supabase_access_token>
// Body: { plan: "project" | "lifetime" }
// Returns: { orderID: "..." }

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
// Use "live" in production, "sandbox" for testing
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();

const PRICES = {
  project: "49.00",
  lifetime: "149.00"
};

function clean(v) {
  return (v ?? "").toString().trim();
}

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

    const plan = clean(req.body?.plan).toLowerCase();
    if (!["project", "lifetime"].includes(plan)) return res.status(400).json({ error: "invalid_plan" });

    const price = PRICES[plan];
    const ppToken = await getPayPalAccessToken();

    const orderResp = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ppToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: `authored_${plan}`,
            custom_id: userId, // ties order to user on capture
            amount: { currency_code: "USD", value: price }
          }
        ]
      })
    });

    const orderData = await orderResp.json().catch(() => ({}));
    if (!orderResp.ok || !orderData.id) {
      return res.status(500).json({ error: "paypal_create_failed", details: orderData });
    }

    return res.status(200).json({ orderID: orderData.id });
  } catch (err) {
    return res.status(500).json({ error: "server_error", details: String(err?.message || err) });
  }
}
