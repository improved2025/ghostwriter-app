// /api/titles.js
// Server-controlled limits for title suggestions.
// Uses: public.usage_limits
// Increments: titles_used
// Returns: { titles: [...] } OR { error: "limit_reached" }

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ✅ PLAN LIMITS (FINAL)
const LIMITS = {
  free: { titles_total: 1 },
  project: { titles_total: 10 },
  lifetime: { titles_total: Infinity }
};

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function clean(v) {
  return (v ?? "").toString().trim();
}

/**
 * Extract a Supabase access token from:
 * - Authorization: Bearer <token>
 * - Cookies: sb-access-token or supabase-auth-token
 */
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

async function getUserId({ supabaseAdmin, req, body }) {
  // Prefer explicit userId if frontend sends it
  const bodyUserId = clean(body?.userId);
  if (bodyUserId) return bodyUserId;

  const token = extractAccessToken(req);
  if (!token) return null;

  const u = await supabaseAdmin.auth.getUser(token);
  return u?.data?.user?.id || null;
}

async function ensureUsageRow({ supabaseAdmin, userId }) {
  const existing = await supabaseAdmin
    .from("usage_limits")
    .select("user_id, plan, titles_used, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) {
    return { ok: false, err: `usage_limits read failed: ${existing.error.message}` };
  }

  if (existing.data) return { ok: true, row: existing.data };

  // Create a default free row
  const ins = await supabaseAdmin
    .from("usage_limits")
    .insert({
      user_id: userId,
      plan: "free",
      titles_used: 0,
      updated_at: new Date().toISOString()
    })
    .select("user_id, plan, titles_used, updated_at")
    .single();

  if (ins.error) {
    return { ok: false, err: `usage_limits insert failed: ${ins.error.message}` };
  }

  return { ok: true, row: ins.data };
}

async function consumeTitlesLimit({ supabaseAdmin, userId }) {
  if (!userId) {
    // Authored model requires identity even for guests (account.js).
    // If we can't resolve userId, treat as not authenticated.
    return { allowed: false, notAuthed: true };
  }

  const ensured = await ensureUsageRow({ supabaseAdmin, userId });
  if (!ensured.ok) return { allowed: false, hardError: ensured.err };

  const row = ensured.row;
  const plan = clean(row?.plan || "free").toLowerCase();

  // Lifetime bypass
  if (plan === "lifetime") return { allowed: true };

  const limit = LIMITS[plan]?.titles_total ?? LIMITS.free.titles_total;
  const used = Number(row?.titles_used || 0);

  if (used >= limit) {
    return { allowed: false, limitReached: true };
  }

  const upd = await supabaseAdmin
    .from("usage_limits")
    .update({
      titles_used: used + 1,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", userId);

  if (upd.error) {
    return { allowed: false, hardError: `usage_limits update failed: ${upd.error.message}` };
  }

  return { allowed: true };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "method_not_allowed" });
    }

    if (!OPENAI_API_KEY) return json(res, 500, { error: "Missing OPENAI_API_KEY" });
    if (!SUPABASE_URL) return json(res, 500, { error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(res, 500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const body = req.body || {};
    const topic = clean(body.topic);
    const audience = clean(body.audience);
    const blocker = clean(body.blocker);
    const currentTitle = clean(body.currentTitle);
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    const idea = topic || currentTitle || "A helpful book idea";

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    const userId = await getUserId({ supabaseAdmin, req, body });

    // Consume limit BEFORE spending tokens
    const lim = await consumeTitlesLimit({ supabaseAdmin, userId });
    if (!lim.allowed) {
      if (lim.notAuthed) return json(res, 401, { error: "not_authenticated" });
      if (lim.limitReached) return json(res, 200, { error: "limit_reached" });
      return json(res, 500, { error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const system = [
      "You generate book title suggestions.",
      "Return only JSON, no extra text.",
      "Titles must be punchy, clear, and not generic.",
      "Avoid clickbait. Avoid overly long titles."
    ].join(" ");

    const user = {
      task: "Generate 10 title suggestions",
      idea,
      audience,
      blocker,
      currentTitle,
      voiceNotes,
      voiceSample_snippet: voiceSample ? voiceSample.slice(0, 1800) : "",
      output_schema: { titles: ["string"] }
    };

    const resp = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ],
      response_format: { type: "json_object" }
    });

    const raw = resp.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    const titles = Array.isArray(parsed.titles)
      ? parsed.titles.map((t) => clean(t)).filter(Boolean).slice(0, 10)
      : [];

    if (!titles.length) {
      return json(res, 500, { error: "no_titles_returned" });
    }

    return json(res, 200, { titles });
  } catch (err) {
    return json(res, 500, { error: "server_error", details: String(err?.message || err) });
  }
}
