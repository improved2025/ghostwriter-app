// /api/expand.js
// Server-controlled expand limits using public.usage_limits
// Free: 2 expands per UTC day (shared bucket for expand + regen)
// Project ($49): 40 total chapter-level generations (expand + chapter shared), lock at first expansion
// Lifetime ($149): unlimited
// Works for logged-in users AND guests (because account.js ensures anonymous auth + cookie token)

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./_supabase.js";
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// ✅ FINALIZED PLAN LIMITS
const FREE_LIMITS = { expands_per_day: 2 };
const PROJECT_LIMITS = { expands_total: 40 };

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

/* ===========================
   PROJECT LOCK FINGERPRINT
   Lock at first expansion for project plan.
   Deterministic and stable: title + topic only.
=========================== */
function normalizeForFingerprint(s) {
  return clean(s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim()
    .slice(0, 500);
}

function makeProjectFingerprint({ bookTitle, topic }) {
  const base = `${normalizeForFingerprint(bookTitle)}|${normalizeForFingerprint(topic)}`;
  return crypto.createHash("sha256").update(base).digest("hex");
}

async function consumeExpand({ supabase, userId, bookTitle, topic }) {
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

  // Lifetime bypass
  if (plan === "lifetime") return { allowed: true };

  // Compute fingerprint for project locking
  const fingerprint = makeProjectFingerprint({ bookTitle, topic });

  // Project plan: lock at first expansion + enforce total cap
  if (plan === "project") {
    const storedFp = clean(row?.project_fingerprint || "");
    if (storedFp && storedFp !== fingerprint) {
      return { allowed: false, projectLocked: true };
    }

    const usedTotal = Number(row?.expands_used || 0);
    if (usedTotal >= PROJECT_LIMITS.expands_total) {
      return { allowed: false, limitReached: true, limitType: "total" };
    }

    const nextTotal = usedTotal + 1;

    const up = await supabase
      .from("usage_limits")
      .upsert(
        {
          user_id: userId,
          plan: row?.plan || "project",
          project_fingerprint: storedFp || fingerprint, // set on first expansion
          expands_used: nextTotal,
          // keep day fields consistent even if unused for project plan
          expands_day: row?.expands_day || today,
          expands_used_today: row?.expands_used_today || 0,
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id" }
      );

    if (up.error) return { allowed: false, hardError: up.error.message };
    return { allowed: true };
  }

  // Free plan: daily cap (existing behavior) + track total
  // Default to free if unknown plan value
  const rowDay = row?.expands_day ? String(row.expands_day).slice(0, 10) : null;
  const usedToday = Number(row?.expands_used_today || 0);
  const effectiveUsed = rowDay === today ? usedToday : 0;

  if (effectiveUsed >= FREE_LIMITS.expands_per_day) {
    return { allowed: false, limitReached: true, limitType: "daily" };
  }

  const nextUsedToday = effectiveUsed + 1;
  const nextTotal = Number(row?.expands_used || 0) + 1;

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
    const lim = await consumeExpand({
      supabase,
      userId: authedUserId,
      bookTitle: clean(bookTitle),
      topic: clean(topic)
    });

    if (!lim.allowed) {
      if (lim.projectLocked) {
        // Keep pattern: 200 with structured error for UI to handle
        return res.status(200).json({ error: "project_locked" });
      }
      if (lim.limitReached) {
        // Preserve existing UI behavior:
        // Free daily cap uses limit_reached_today
        // Project total cap uses limit_reached (generic)
        if (lim.limitType === "daily") return res.status(200).json({ error: "limit_reached_today" });
        return res.status(200).json({ error: "limit_reached" });
      }
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
