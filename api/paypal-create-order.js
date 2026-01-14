// /api/paypal-create-order.js
// Creates a PayPal order and returns { orderID }.
// Requires logged-in user (Supabase access token via Bearer or cookie).

import { createClient } from "@supabase/supabase-js";

const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const PRICE_USD = {
  project: "49.00",
  lifetime: "149.00",
};

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

function paypalBase() {
  return PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function basicAuth() {
  const raw = `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`;
  return Buffer.from(raw).toString("base64");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    if (!PAYPAL_CLIENT_ID) return res.status(500).json({ error: "Missing PAYPAL_CLIENT_ID" });
    if (!PAYPAL_CLIENT_SECRET) return res.status(500).json({ error: "Missing PAYPAL_CLIENT_SECRET" });

    const userId = await requireUserId(req);
    if (!userId) return res.status(401).json({ error: "not_authenticated" });

    const plan = (req.body?.plan || "").toString().toLowerCase();
    const amount = PRICE_USD[plan];
    if (!amount) return res.status(400).json({ error: "invalid_plan" });

    // Create order
    const resp = await fetch(`${paypalBase()}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: amount },
            custom_id: userId,
            description: `Authored ${plan} plan`,
          },
        ],
      }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.id) {
      return res.status(500).json({ error: "paypal_create_order_failed", details: data });
    }

    return res.status(200).json({ orderID: data.id });
  } catch (err) {
    return res.status(500).json({ error: "server_error", details: String(err?.message || err) });
  }
}
