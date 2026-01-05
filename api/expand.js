// /api/expand.js
// Server-controlled expand limits using public.usage_limits
// Free: 2 expands per day (shared bucket for expand + regen)
// Works for logged-in users AND guests (because account.js now ensures anonymous auth + cookie token)

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./_supabase.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const FREE_LIMITS = { expands_per_day: 2 };

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

function todayISODateUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`; // YYYY-MM-DD
}

async function consumeExpand({ supabase, userId }) {
  const today = todayISODateUTC();

  // Fetch row
  const existing = await supabase
    .from("usage_limits")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) return { allowed: false, hardError: existing.error.message };

  const row = existing.data;
  const plan = (row?.plan || "free").toString().toLowerCase();
  if (plan !== "free") return { allowed: true };

  const rowDay = row?.expands_day ? String(row.expands_day).slice(0, 10) : null;
  const usedToday = Number(row?.expands_used_today || 0);
  const effectiveUsed = rowDay === today ? usedToday : 0;

  if (effectiveUsed >= FREE_LIMITS.expands_per_day) {
    return { allowed: false, limitReached: true };
  }

  const nextUsedToday = effectiveUsed + 1;
  const nextTotal = Number(row?.expands_used || 0) + 1;

  // Upsert row keyed by user_id
  const up = await supabase
    .from("usage_limits")
    .upsert(
      {
        user_id: userId,
        plan: row?.plan || "free",
        expands_day: today,
        expands_used_today: nextUsedToday,
        expands_used: nextTotal,
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id" }
    );

  if (up.error) return { allowed: false, hardError: up.error.message };
  return { allowed: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const openai = new OpenAI({ apiKey });

    const body = req.body || {};

    const authedUserId = await getUserIdFromRequest(req);
    if (!authedUserId) {
      // This is the whole point of account.js cookie auth sync.
      return res.status(401).json({ error: "not_authenticated" });
    }

    const {
      topic,
      audience,
      bookTitle,
      purpose,
      chapterTitle,
      chapterNumber,
      voiceSample,
      voiceNotes,
      minWords = 900,
      maxWords = 1300
    } = body;

    if (!clean(chapterTitle) || !clean(topic)) {
      return res.status(400).json({ error: "Missing chapterTitle or topic" });
    }

    const supabase = supabaseAdmin();

    // Enforce expand limits (logged-in + guest both have user_id now)
    const lim = await consumeExpand({ supabase, userId: authedUserId });
    if (!lim.allowed) {
      if (lim.limitReached) return res.status(200).json({ error: "limit_reached_today" });
      return res.status(500).json({ error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    const voiceBlock = clean(voiceSample)
      ? `VOICE SAMPLE (match style strictly):\n${voiceSample}\n\nVOICE NOTES:\n${voiceNotes || "none"}`
      : `VOICE NOTES:\n${voiceNotes || "none"} (Keep voice human.)`;

    const prompt = `
Write a chapter draft.

Book: ${clean(bookTitle)}
Purpose: ${clean(purpose)}
Chapter ${Number(chapterNumber) || 1}: ${clean(chapterTitle)}
Audience: ${clean(audience)}
Topic context: ${clean(topic)}

${voiceBlock}

Rules:
- Human voice only
- No AI mentions
- ${Number(minWords) || 900}–${Number(maxWords) || 1300} words
- Headings + flow
- End with 5 reflection questions

Return JSON only:
{ "expanded": "..." }
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a strict writing coach." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    const raw = resp.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}

    const expanded = typeof parsed.expanded === "string" ? clean(parsed.expanded) : "";
    if (!expanded) return res.status(500).json({ error: "no_expanded_text_returned" });

    return res.status(200).json({ expanded });
  } catch (err) {
    return res.status(500).json({ error: "Expand failed", details: String(err?.message || err) });
  }
}
