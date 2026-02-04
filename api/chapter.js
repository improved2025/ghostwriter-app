// /api/chapter.js
// Chapter blueprint MUST consume the same expand limits as /api/expand.js.
// Free: 2/day shared bucket
// Project: 40 total + lock at first chapter-level call
// Lifetime: unlimited

import OpenAI from "openai";
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

function normalizeForLock(v) {
  return clean(v).toLowerCase().replace(/\s+/g, " ").slice(0, 2000);
}

function lockHashFromBody(body) {
  const topic = normalizeForLock(body?.topic);
  const audience = normalizeForLock(body?.audience);
  const blocker = normalizeForLock(body?.blocker);
  const base = `topic:${topic}|aud:${audience}|blocker:${blocker}`;
  return crypto.createHash("sha256").update(base).digest("hex");
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
  return `${y}-${m}-${day}`;
}

async function consumeExpand({ supabase, userId, body }) {
  const today = todayISODateUTC();

  const existing = await supabase
    .from("usage_limits")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) return { allowed: false, hardError: existing.error.message };

  const row = existing.data;
  const plan = (row?.plan || "free").toString().toLowerCase();

  if (plan === "lifetime") {
    const nextTotal = Number(row?.expands_used || 0) + 1;
    const up = await supabase
      .from("usage_limits")
      .upsert(
        { user_id: userId, plan: row?.plan || "lifetime", expands_used: nextTotal, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
    if (up.error) return { allowed: false, hardError: up.error.message };
    return { allowed: true };
  }

  if (plan === "project") {
    const cap = Number(row?.project_expands_cap || PROJECT_LIMITS.expands_total);
    const used = Number(row?.expands_used || 0);

    if (used >= cap) return { allowed: false, limitReached: true };

    const incomingLock = lockHashFromBody(body);
    const currentLock = clean(row?.project_lock_hash);

    if (currentLock && currentLock !== incomingLock) {
      return { allowed: false, projectLocked: true };
    }

    const nextTotal = used + 1;
    const up = await supabase
      .from("usage_limits")
      .upsert(
        {
          user_id: userId,
          plan: row?.plan || "project",
          project_lock_hash: currentLock || incomingLock,
          project_expands_cap: row?.project_expands_cap ?? PROJECT_LIMITS.expands_total,
          expands_used: nextTotal,
          updated_at: new Date().toISOString()
        },
        { onConflict: "user_id" }
      );

    if (up.error) return { allowed: false, hardError: up.error.message };
    return { allowed: true };
  }

  const rowDay = row?.expands_day ? String(row.expands_day).slice(0, 10) : null;
  const usedToday = Number(row?.expands_used_today || 0);
  const effectiveUsed = rowDay === today ? usedToday : 0;

  if (effectiveUsed >= FREE_LIMITS.expands_per_day) {
    return { allowed: false, limitReachedToday: true };
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

    const body = req.body || {};

    const userId = await getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "not_authenticated" });

    const bookTitle = clean(body.title) || "Untitled";
    const bookPurpose = clean(body.purpose) || "";
    const aud = clean(body.audience) || "the reader";
    const top = clean(body.topic) || "the topic";
    const blocker = clean(body.blocker) || "";
    const ch = clean(body.chapterTitle);

    if (!ch) return res.status(400).json({ error: "Missing chapterTitle" });

    const supabase = supabaseAdmin();
    const lim = await consumeExpand({ supabase, userId, body });
    if (!lim.allowed) {
      if (lim.projectLocked) return res.status(200).json({ error: "project_locked" });
      if (lim.limitReachedToday) return res.status(200).json({ error: "limit_reached_today" });
      if (lim.limitReached) return res.status(200).json({ error: "limit_reached" });
      return res.status(500).json({ error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    const prompt = `
You are a practical writing coach.

Book title: ${bookTitle}
Purpose: ${bookPurpose}
Topic: ${top}
Audience: ${aud}
Blocker: ${blocker}

Chapter to expand: ${ch}

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

    const openai = new OpenAI({ apiKey });

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a practical writing coach." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    const raw = resp.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    return res.status(200).json({
      chapterTitle: clean(data.chapterTitle) || ch,
      summary: clean(data.summary) || "",
      keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints.map(clean).filter(Boolean) : [],
      sampleText: clean(data.sampleText) || ""
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err?.message || err) });
  }
}
