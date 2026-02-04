// /api/intro.js
// Limits:
// Free: 1 total
// Project: 5 total
// Lifetime: unlimited
// Enforced via public.usage_limits

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_LIMITS = { intros_total: 1 };
const PROJECT_LIMITS = { intros_total: 5 };

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

async function consumeIntro({ supabaseAdmin, userId }) {
  const existing = await supabaseAdmin
    .from("usage_limits")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) return { allowed: false, hardError: existing.error.message };

  const row = existing.data;
  const plan = (row?.plan || "free").toString().toLowerCase();

  if (plan === "lifetime") return { allowed: true };

  const used = Number(row?.introductions_used || 0);
  const cap =
    plan === "project"
      ? Number(row?.project_intros_cap || PROJECT_LIMITS.intros_total)
      : FREE_LIMITS.intros_total;

  if (used >= cap) return { allowed: false, limitReached: true };

  const up = await supabaseAdmin
    .from("usage_limits")
    .upsert(
      {
        user_id: userId,
        plan: row?.plan || "free",
        project_intros_cap: row?.project_intros_cap ?? (plan === "project" ? PROJECT_LIMITS.intros_total : null),
        introductions_used: used + 1,
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

    const bookTitle = clean(body.bookTitle);
    const purpose = clean(body.purpose);
    const outline = Array.isArray(body.outline) ? body.outline : [];
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    const lim = await consumeIntro({ supabaseAdmin, userId });
    if (!lim.allowed) {
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

    let introduction = parsed.introduction;
    if (typeof introduction !== "string") introduction = "";
    introduction = clean(introduction);

    if (!introduction) return json(res, 500, { error: "no_introduction_returned" });

    return json(res, 200, { introduction });
  } catch (err) {
    return json(res, 500, { error: "server_error", details: String(err?.message || err) });
  }
}
