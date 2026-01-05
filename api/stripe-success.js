// /api/stripe-success.js
// Verifies a paid Stripe Checkout Session and upgrades the user in Supabase,
// then redirects to /start.html

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.end();
}

export default async function handler(req, res) {
  try {
    const sessionId = (req.query?.session_id || "").toString();
    if (!sessionId) return redirect(res, "/pricing.html");

    if (!STRIPE_SECRET_KEY) return redirect(res, "/pricing.html");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return redirect(res, "/pricing.html");

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || session.payment_status !== "paid") {
      return redirect(res, "/pricing.html");
    }

    const userId = session.metadata?.user_id || null;
    const plan = (session.metadata?.plan || "").toString().toLowerCase();

    if (!userId || (plan !== "project" && plan !== "lifetime")) {
      return redirect(res, "/pricing.html");
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    // Update BOTH tables since your app uses both:
    // - usable_limits (titles/intro/outline usage)
    // - usage_limits (expand limits)
    // If one of these tables doesn't exist in your DB, remove that block.

    await supabaseAdmin
      .from("usable_limits")
      .upsert(
        { user_id: userId, plan, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );

    await supabaseAdmin
      .from("usage_limits")
      .upsert(
        { user_id: userId, plan, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );

    return redirect(res, "/start.html");
  } catch {
    return redirect(res, "/pricing.html");
  }
}
