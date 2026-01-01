// api/paypal-capture-order.js
import { createClient } from "@supabase/supabase-js";

const PRICE = {
  project: { usd: "49.00" },
  lifetime: { usd: "149.00" }
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
  if (!resp.ok) throw new Error(data?.error_description || "PayPal token failed");

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

async function markPaid(userId, plan) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Try to update profiles (if you have it)
  try {
    await admin.from("profiles").upsert(
      { id: userId, is_paid: true, plan: plan, updated_at: new Date().toISOString() },
      { onConflict: "id" }
    );
  } catch {}

  // Update usable_limits (your limiter table)
  // You may already have different column names. Adjust here if needed.
  try {
    // If a row exists, update. If not, insert.
    const { data: existing } = await admin
      .from("usable_limits")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing?.user_id) {
      await admin
        .from("usable_limits")
        .update({ is_paid: true, plan: plan, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
    } else {
      await admin.from("usable_limits").insert({
        user_id: userId,
        is_paid: true,
        plan: plan,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
  } catch {}
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const userId = await requireUserId(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: "Missing orderID" });

    const accessToken = await getPayPalAccessToken();
    const base = getPayPalBase();

    const resp = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return res.status(500).json({ error: "paypal_capture_failed", details: data });
    }

    const status = (data.status || "").toUpperCase();
    if (status !== "COMPLETED") {
      return res.status(400).json({ error: "payment_not_completed", details: { status } });
    }

    const pu = data.purchase_units?.[0];
    const customId = pu?.custom_id || "";
    const ref = pu?.reference_id || "";
    const amountVal = pu?.payments?.captures?.[0]?.amount?.value;

    // custom_id = "userId:plan"
    const [paidUserId, planFromMeta] = customId.split(":");
    const plan = planFromMeta || ref;

    if (!paidUserId || paidUserId !== userId) {
      return res.status(400).json({ error: "user_mismatch" });
    }
    if (!plan || !PRICE[plan]) {
      return res.status(400).json({ error: "invalid_plan" });
    }
    if (String(amountVal) !== String(PRICE[plan].usd)) {
      return res.status(400).json({ error: "amount_mismatch" });
    }

    await markPaid(userId, plan);

    return res.status(200).json({ ok: true, plan });
  } catch (e) {
    return res.status(500).json({ error: "server_error", details: String(e?.message || e) });
  }
}
