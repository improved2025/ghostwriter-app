// /api/chapter.js
// Chapter blueprint endpoint
// Shares quota + project lock with /api/expand
// Free: 2 per UTC day (shared)
// Project: 40 total (shared), lock at first expansion
// Lifetime: unlimited

import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./_supabase.js";
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const FREE_LIMITS = { expands_per_day: 2 };
const PROJECT_LIMITS = { expands_total: 40 };

function clean(v) {
  return (v ?? "").toString().trim();
}

/* ================= AUTH HELPERS ================= */

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
  return d.toISOString().slice(0, 10);
}

/* ================= PROJECT LOCK ================= */

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

/* ================= SHARED QUOTA ================= */

async function consumeChapterGeneration({ supabase, userId, bookTitle, topic }) {
  const today = todayISODateUTC();

  const existing = await supabase
    .from("usage_limits")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) return { allowed: false, hardError: existing.error.message };

  const row = existing.data;
  const plan = (row?.plan || "free").toLowerCase();

  // Lifetime: bypass everything
  if (plan === "lifetime") return { allowed: true };

  const fingerprint = makeProjectFingerprint({ bookTitle, topic });

  // Project plan: total cap + project lock
  if (plan === "project") {
    const storedFp = clean(row?.project_fingerprint || "");
    if (storedFp && storedFp !== fingerprint) {
      return { allowed: false, projectLocked: true };
    }

    const usedTotal = Number(row?.expands_used || 0);
    if (usedTotal >= PROJECT_LIMITS.expands_total) {
      return { allowed: false, limitReached: true, limitType: "total" };
    }

    const up = await supabase
      .from("usage_limits")
      .upsert(
        {
          user_id: userId,
          plan: "project",
          project_fingerprint: storedFp || fingerprint,
          expands_used: usedTotal + 1,
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id" }
      );

    if (up.error) return { allowed: false, hardError: up.error.message };
    return { allowed: true };
  }

  // Free plan: daily cap
  const rowDay = row?.expands_day ? String(row.expands_day).slice(0, 10) : null;
  const usedToday = Number(row?.expands_used_today || 0);
  const effectiveUsed = rowDay === today ? usedToday : 0;

  if (effectiveUsed >= FREE_LIMITS.expands_per_day) {
    return { allowed: false, limitReached: true, limitType: "daily" };
  }

  const up = await supabase
    .from("usage_limits")
    .upsert(
      {
        user_id: userId,
        plan: "free",
        expands_day: today,
        expands_used_today: effectiveUsed + 1,
        expands_used: Number(row?.expands_used || 0) + 1,
        updated_at: new Date().toISOString()
      },
      { onConflict: "user_id" }
    );

  if (up.error) return { allowed: false, hardError: up.error.message };
  return { allowed: true };
}

/* ================= HANDLER ================= */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const body = req.body || {};
    const bookTitle = clean(body.title) || "Untitled";
    const bookPurpose = clean(body.purpose) || "";
    const audience = clean(body.audience) || "the reader";
    const topic = clean(body.topic) || "the topic";
    const chapterTitle = clean(body.chapterTitle);

    if (!chapterTitle) {
      return res.status(400).json({ error: "Missing chapterTitle" });
    }

    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const supabase = supabaseAdmin();

    const lim = await consumeChapterGeneration({
      supabase,
      userId,
      bookTitle,
      topic
    });

    if (!lim.allowed) {
      if (lim.projectLocked) {
        return res.status(200).json({ error: "project_locked" });
      }
      if (lim.limitReached) {
        if (lim.limitType === "daily") {
          return res.status(200).json({ error: "limit_reached_today" });
        }
        return res.status(200).json({ error: "limit_reached" });
      }
      return res.status(500).json({ error: "limit_check_failed", details: lim.hardError });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

    const prompt = `
You are a practical writing coach.

Book title: ${bookTitle}
Purpose: ${bookPurpose}
Topic: ${topic}
Audience: ${audience}

Chapter to expand: ${chapterTitle}

Return:
- a one-sentence chapter summary
- 6–8 key points (bullets)
- a short sample paragraph (5–8 sentences) in a clear, human tone

No hype. No mention of AI.

Return JSON ONLY in this format:
{
  "chapterTitle": "...",
  "summary": "...",
  "keyPoints": ["...", "..."],
  "sampleText": "..."
}
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a practical writing coach." },
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      })
    });

    const raw = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: "OpenAI request failed", details: raw });
    }

    let data;
    try {
      data = JSON.parse(raw?.choices?.[0]?.message?.content || "{}");
    } catch {
      return res.status(500).json({ error: "Model did not return valid JSON" });
    }

    return res.status(200).json({
      chapterTitle: clean(data.chapterTitle) || chapterTitle,
      summary: clean(data.summary) || "",
      keyPoints: Array.isArray(data.keyPoints)
        ? data.keyPoints.map(clean).filter(Boolean)
        : [],
      sampleText: clean(data.sampleText) || ""
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
