// /api/stripe-create-checkout.js
// Creates Stripe Checkout and returns { url }.
// Requires Authorization: Bearer <supabase_access_token>

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_PROJECT = process.env.STRIPE_PRICE_PROJECT;
const STRIPE_PRICE_LIFETIME = process.env.STRIPE_PRICE_LIFETIME;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function extractAccessToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/Bearer\s+(.+)/i);
  if (m?.[1]) return m[1].trim();

  const cookie = req.headers.cookie || "";
  const sbAccess = cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
  if (sbAccess?.[1]) return decodeURIComponent(sbAccess[1]);

  return null;
}

async function getUserIdFromRequest(req) {
  const token = extractAccessToken(req);
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;

  const authed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const u = await authed.auth.getUser();
  return u?.data?.user?.id || null;
}

function originFromReq(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    if (!STRIPE_PRICE_PROJECT) return res.status(500).json({ error: "Missing STRIPE_PRICE_PROJECT" });
    if (!STRIPE_PRICE_LIFETIME) return res.status(500).json({ error: "Missing STRIPE_PRICE_LIFETIME" });

    const userId = await getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "not_authenticated" });

    const plan = (req.body?.plan || "").toString().toLowerCase();
    const priceId =
      plan === "project" ? STRIPE_PRICE_PROJECT :
      plan === "lifetime" ? STRIPE_PRICE_LIFETIME :
      null;

    if (!priceId) return res.status(400).json({ error: "invalid_plan" });

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
    const origin = originFromReq(req);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/api/stripe-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing.html`,
      metadata: { user_id: userId, plan }
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: "stripe_checkout_failed", details: String(err?.message || err) });
  }
}
