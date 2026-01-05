// /api/stripe-create-checkout.js
// Creates a Stripe Checkout Session and returns { url }
// Requires logged-in user (Authorization: Bearer <supabase_access_token>)

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// Set these in Vercel env (Stripe Price IDs)
const STRIPE_PRICE_PROJECT = process.env.STRIPE_PRICE_PROJECT;   // price_xxx
const STRIPE_PRICE_LIFETIME = process.env.STRIPE_PRICE_LIFETIME; // price_xxx

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function extractAccessToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/Bearer\s+(.+)/i);
  if (m?.[1]) return m[1].trim();

  const cookie = req.headers.cookie || "";

  const sbAccess = cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
  if (sbAccess?.[1]) return decodeURIComponent(sbAccess[1]);

  const supa = cookie.match(/(?:^|;\s*)supabase-auth-token=([^;]+)/);
  if (supa?.[1]) {
    try {
      const raw = decodeURIComponent(supa[1]);
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr[0]) return arr[0];
    } catch {}
  }

  return null;
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

function originFromReq(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "method_not_allowed" });
    }

    if (!STRIPE_SECRET_KEY) return json(res, 500, { error: "Missing STRIPE_SECRET_KEY" });
    if (!STRIPE_PRICE_PROJECT) return json(res, 500, { error: "Missing STRIPE_PRICE_PROJECT" });
    if (!STRIPE_PRICE_LIFETIME) return json(res, 500, { error: "Missing STRIPE_PRICE_LIFETIME" });

    const userId = await getUserIdFromRequest(req);
    if (!userId) return json(res, 401, { error: "not_authenticated" });

    const body = req.body || {};
    const plan = (body.plan || "").toString().toLowerCase();

    let priceId = null;
    if (plan === "project") priceId = STRIPE_PRICE_PROJECT;
    if (plan === "lifetime") priceId = STRIPE_PRICE_LIFETIME;
    if (!priceId) return json(res, 400, { error: "invalid_plan" });

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    const origin = originFromReq(req);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/api/stripe-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing.html`,
      metadata: {
        user_id: userId,
        plan
      }
    });

    return json(res, 200, { url: session.url });
  } catch (err) {
    return json(res, 500, { error: "stripe_checkout_failed", details: String(err?.message || err) });
  }
}
