// /api/titles.js
// Limits:
// Free: 1 total
// Project: 10 total
// Lifetime: unlimited
// Enforced via public.usage_limits

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_LIMITS = { titles_total: 1 };
const PROJECT_LIMITS = { titles_total: 10 };

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function clean(v) {
  return (v ?? "").toString().trim();
}

function extractAccessToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/Bearer\s+(.+)/i);
  if (m?.[1]) return m[1].trim();

  const cookie = req.headers.cookie || "";
  const sbAccess = cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
  if (sbAccess?.[1]) return decodeURIComponent(sbAccess[1]);

  return null;
}

async function getUserIdFromRequest(supabaseAdmin, req) {
  const token = extractAccessToken(req);
  if (!token) return null;
  const u = await supabaseAdmin.auth.getUser(token);
  return u?.data?.user?.id || null;
}

async function consumeTitles({ supabaseAdmin, userId }) {
  const existing = await supabaseAdmin
    .from("usage_limits")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) return { allowed: false, hardError: existing.error.message };

  const row = existing.data;
  const plan = (row?.plan || "free").toString().toLowerCase();

  if (plan === "lifetime") return { allowed: true };

  const used = Number(row?.titles_used || 0);
  const cap =
    plan === "project"
      ? Number(row?.project_titles_cap || PROJECT_LIMITS.titles_total)
      : FREE_LIMITS.titles_total;

  if (used >= cap) return { allowed: false, limitReached: true };

  const up = await supabaseAdmin
    .from("usage_limits")
    .upsert(
      {
        user_id: userId,
        plan: row?.plan || "free",
        project_titles_cap: row?.project_titles_cap ?? (plan === "project" ? PROJECT_LIMITS.titles_total : null),
        titles_used: used + 1,
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id" }
    );

  if (up.error) return { allowed: false, hardError: up.error.message };
  return { allowed: true };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

    if (!OPENAI_API_KEY) return json(res, 500, { error: "Missing OPENAI_API_KEY" });
    if (!SUPABASE_URL) return json(res, 500, { error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(res, 500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    const userId = await getUserIdFromRequest(supabaseAdmin, req);
    if (!userId) return json(res, 401, { error: "not_authenticated" });

    const body = req.body || {};
    const topic = clean(body.topic);
    const audience = clean(body.audience);
    const blocker = clean(body.blocker);
    const currentTitle = clean(body.currentTitle);
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    const lim = await consumeTitles({ supabaseAdmin, userId });
    if (!lim.allowed) {
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

    const idea = topic || currentTitle || "A helpful book idea";

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
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}

    const titles = Array.isArray(parsed.titles)
      ? parsed.titles.map((t) => clean(t)).filter(Boolean).slice(0, 10)
      : [];

    if (!titles.length) return json(res, 500, { error: "no_titles_returned" });

    return json(res, 200, { titles });
  } catch (err) {
    return json(res, 500, { error: "server_error", details: String(err?.message || err) });
  }
}
