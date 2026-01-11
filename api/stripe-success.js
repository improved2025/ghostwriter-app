// /api/stripe-success.js
// Verifies Stripe checkout session, upgrades plan in public.usage_limits, then redirects to start.html

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function originFromReq(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Use GET" });
    }

    if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const sessionId = (req.query?.session_id || "").toString().trim();
    if (!sessionId) return res.status(400).json({ error: "Missing session_id" });

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Must be paid (or at least complete)
    if (!session || (session.payment_status !== "paid" && session.status !== "complete")) {
      return res.status(400).json({ error: "payment_not_complete" });
    }

    // We set these in stripe-create-checkout metadata
    const userId = session?.metadata?.user_id || "";
    const plan = (session?.metadata?.plan || "").toLowerCase();

    if (!userId) return res.status(400).json({ error: "missing_user_id_metadata" });
    if (plan !== "project" && plan !== "lifetime") {
      return res.status(400).json({ error: "invalid_plan_metadata" });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    // Upsert into usage_limits
    const up = await supabaseAdmin
      .from("usage_limits")
      .upsert(
        {
          user_id: userId,
          plan,
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id" }
      );

    if (up.error) {
      return res.status(500).json({ error: "supabase_update_failed", details: up.error.message });
    }

    // Redirect back to app
    const origin = originFromReq(req);
    return res.redirect(303, `${origin}/start.html?upgraded=${encodeURIComponent(plan)}`);
  } catch (err) {
    return res.status(500).json({
      error: "stripe_success_failed",
      details: String(err?.message || err)
    });
  }
}
