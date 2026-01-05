// /api/stripe-webhook.js
// Optional: upgrades user based on webhook event checkout.session.completed

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (chunk) => chunks.push(chunk));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

export default async function handler(req, res) {
  try {
    if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
      res.status(500).send("Missing Stripe webhook env vars");
      return;
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
    const rawBody = await buffer(req);
    const sig = req.headers["stripe-signature"];

    const event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);

    if (event.type !== "checkout.session.completed") {
      res.json({ received: true });
      return;
    }

    const session = event.data.object;
    if (session.payment_status !== "paid") {
      res.json({ received: true });
      return;
    }

    const userId = session.metadata?.user_id || null;
    const plan = (session.metadata?.plan || "").toString().toLowerCase();
    if (!userId || (plan !== "project" && plan !== "lifetime")) {
      res.json({ received: true });
      return;
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    await supabaseAdmin
      .from("usable_limits")
      .upsert({ user_id: userId, plan, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

    await supabaseAdmin
      .from("usage_limits")
      .upsert({ user_id: userId, plan, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

    res.json({ received: true });
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
}
