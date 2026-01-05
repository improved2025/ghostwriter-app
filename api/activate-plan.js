// /api/activate-plan.js
// Sets usage_limits.plan for the authenticated user.
// Expects Authorization: Bearer <supabase_access_token>
// Body: { plan: "project" | "lifetime" }

import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./_supabase.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const plan = clean(req.body?.plan).toLowerCase();
    if (!["project", "lifetime"].includes(plan)) {
      return res.status(400).json({ error: "invalid_plan" });
    }

    const userId = await getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "not_authenticated" });

    const sb = supabaseAdmin();

    // Ensure row exists, then set plan
    const up = await sb
      .from("usage_limits")
      .upsert(
        {
          user_id: userId,
          plan: plan, // not "free"
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id" }
      );

    if (up.error) return res.status(500).json({ error: "db_write_failed", details: up.error.message });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "server_error", details: String(err?.message || err) });
  }
}
