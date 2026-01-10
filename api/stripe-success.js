// /api/stripe-success.js
// Verifies Stripe Checkout session + unlocks the user by updating public.usage_limits.plan
// Redirects back to start.html when done.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function originFromReq(req) {
  const
