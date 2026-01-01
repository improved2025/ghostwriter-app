// api/paypal-create-order.js
import { createClient } from "@supabase/supabase-js";

const PRICE = {
  project: { usd: "49.00", label: "Project plan" },
  lifetime: { usd: "149.00", label: "Lifetime" }
};

function getPayPalBase() {
  const env = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function getPayPalAccessToken() {
  const base = getPayPalBase();
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (!id || !secret) throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");

  const auth = Buffer.from(`${id}:${secret}`).toString("base64");

  const resp = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error_description || "PayPal token failed");
  }

  return data.access_token;
}

async function requireUserId(req) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) return null;

  const sb = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.getUser(token);
  if (error) return null;

  return data?.user?.id || null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const userId = await requireUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { plan } = req.body || {};
    if (!plan || !PRICE[plan]) return res.status(400).json({ error: "Invalid plan" });

    const accessToken = await getPayPalAccessToken();
    const base = getPayPalBase();

    const invoiceId = `authored_${userId}_${plan}_${Date.now()}`;

    const resp = await fetch(`${base}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: plan,
            description: PRICE[plan].label,
            custom_id: `${userId}:${plan}`, // we verify this on capture
            invoice_id: invoiceId,
            amount: {
              currency_code: "USD",
              value: PRICE[plan].usd
            }
          }
        ]
      })
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return res.status(500).json({ error: "paypal_create_order_failed", details: data });
    }

    return res.status(200).json({ orderID: data.id });
  } catch (e) {
    return res.status(500).json({ error: "server_error", details: String(e?.message || e) });
  }
}
