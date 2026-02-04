// /api/intro.js
// Server-controlled limits for introductions using public.usage_limits
// Free: 1 total
// Project: 5 total
// Lifetime: unlimited
// Returns: { introduction: "..." } OR { error: "limit_reached" }

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// FINAL PLAN LIMITS
const LIMITS = {
  free: { introductions_total: 1 },
  project: { introductions_total: 5 },
  lifetime: { introductions_total: Infinity }
};

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function clean(v) {
  return (v ?? "").toString().trim();
}

/* ================= AUTH ================= */

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

/* ================= LIMITS ================= */

async function ensureUsageRow({ supabaseAdmin, userId }) {
  const existing = await supabaseAdmin
    .from("usage_limits")
    .select("user_id, plan, introductions_used, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) {
    return { ok: false, err: existing.error.message };
  }

  if (existing.data) return { ok: true, row: existing.data };

  const ins = await supabaseAdmin
    .from("usage_limits")
    .insert({
      user_id: userId,
      plan: "free",
      introductions_used: 0,
      updated_at: new Date().toISOString()
    })
    .select("user_id, plan, introductions_used, updated_at")
    .single();

  if (ins.error) {
    return { ok: false, err: ins.error.message };
  }

  return { ok: true, row: ins.data };
}

async function consumeIntroLimit({ supabaseAdmin, userId }) {
  if (!userId) return { allowed: false, notAuthed: true };

  const ensured = await ensureUsageRow({ supabaseAdmin, userId });
  if (!ensured.ok) return { allowed: false, hardError: ensured.err };

  const row = ensured.row;
  const plan = clean(row.plan || "free").toLowerCase();

  // Lifetime bypass
  if (plan === "lifetime") return { allowed: true };

  const limit = LIMITS[plan]?.introductions_total ?? LIMITS.free.introductions_total;
  const used = Number(row.introductions_used || 0);

  if (used >= limit) return { allowed: false, limitReached: true };

  const upd = await supabaseAdmin
    .from("usage_limits")
    .update({
      introductions_used: used + 1,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", userId);

  if (upd.error) return { allowed: false, hardError: upd.error.message };

  return { allowed: true };
}

/* ================= HANDLER ================= */

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "method_not_allowed" });
    }

    if (!OPENAI_API_KEY) return json(res, 500, { error: "Missing OPENAI_API_KEY" });
    if (!SUPABASE_URL) return json(res, 500, { error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(res, 500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const body = req.body || {};
    const bookTitle = clean(body.bookTitle);
    const purpose = clean(body.purpose);
    const outline = Array.isArray(body.outline) ? body.outline : [];
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    const userId = await getUserIdFromRequest(req);

    const lim = await consumeIntroLimit({ supabaseAdmin, userId });
    if (!lim.allowed) {
      if (lim.notAuthed) return json(res, 401, { error: "not_authenticated" });
      if (lim.limitReached) return json(res, 200, { error: "limit_reached" });
      return json(res, 500, { error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const system = `
You are a writing coach.
Write WITH the author, not for them.
Match tone and cadence.
No AI references. No hype.
Return JSON only.
`.trim();

    const userPrompt = {
      task: "Write a book introduction",
      bookTitle,
      purpose,
      outline,
      voiceNotes,
      voiceSample_snippet: voiceSample ? voiceSample.slice(0, 2000) : "",
      constraints: { minWords: 400, maxWords: 700 },
      output_schema: { introduction: "string" }
    };

    const resp = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userPrompt) }
      ],
      response_format: { type: "json_object" }
    });

    const raw = resp.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}

    let introduction = typeof parsed.introduction === "string" ? clean(parsed.introduction) : "";
    if (!introduction) return json(res, 500, { error: "no_introduction_returned" });

    return json(res, 200, { introduction });
  } catch (err) {
    return json(res, 500, { error: "server_error", details: String(err?.message || err) });
  }
}
