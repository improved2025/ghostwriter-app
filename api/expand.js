import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase.js";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const FREE_LIMITS = {
  expands_per_day: 2 // free: 2 expands/regens per day (shared bucket)
};

function clean(v) {
  return (v ?? "").toString().trim();
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function getIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "0.0.0.0";
}

function extractAccessToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/Bearer\s+(.+)/i);
  if (m?.[1]) return m[1].trim();
  return null;
}

function todayKeyUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Enforce expand/regen limits.
 * Priority:
 * 1) If user is logged in AND RPC consume_limit exists -> use it.
 * 2) Otherwise fallback to usable_limits table for guest and for cases RPC isn't present.
 *
 * Fallback expected columns (if missing, add them):
 * - expansions_day (text) e.g. "2026-01-01"
 * - expansions_used (int)
 * - plan (text) default "free"
 * - user_id (uuid nullable)
 * - guest_key (text nullable)
 */
async function consumeExpandLimit({ supabase, userId, guestKey, projectId, kind }) {
  // 1) RPC for logged in users (your existing working path)
  if (userId) {
    const variants = [
      { fn: "consume_limit", args: { p_user_id: userId, p_project_id: projectId, p_kind: kind } },
      { fn: "consume_limit", args: { user_id: userId, project_id: projectId, kind } },
      { fn: "consume_project_limit", args: { p_user_id: userId, p_project_id: projectId, p_kind: kind } },
    ];

    for (const v of variants) {
      const r = await supabase.rpc(v.fn, v.args);
      if (!r.error) {
        // Expect {allowed:true/false} or boolean
        if (typeof r.data === "boolean") return { allowed: r.data };
        if (r.data?.allowed !== undefined) return { allowed: !!r.data.allowed };
        if (r.data?.ok !== undefined) return { allowed: !!r.data.ok };
        return { allowed: true };
      }
    }
  }

  // 2) Fallback to usable_limits (guest OR if RPC not found)
  const day = todayKeyUTC();

  let q = supabase.from("usable_limits").select("*").limit(1);
  q = userId ? q.eq("user_id", userId) : q.eq("guest_key", guestKey);

  const existing = await q.maybeSingle();
  if (existing.error) return { allowed: false, hardError: existing.error.message };

  const row = existing.data;
  const plan = (row?.plan || "free").toString().toLowerCase();
  if (plan !== "free") return { allowed: true };

  const currentDay = (row?.expansions_day || "").toString();
  let used = Number(row?.expansions_used || 0);

  // reset bucket daily
  if (currentDay !== day) used = 0;

  if (used >= FREE_LIMITS.expands_per_day) {
    return { allowed: false, limitReached: true };
  }

  if (row) {
    const upd = await supabase
      .from("usable_limits")
      .update({
        expansions_day: day,
        expansions_used: used + 1,
        updated_at: new Date().toISOString()
      })
      .eq("id", row.id);

    if (upd.error) return { allowed: false, hardError: upd.error.message };
    return { allowed: true };
  }

  const insPayload = userId
    ? { user_id: userId, plan: "free", expansions_day: day, expansions_used: 1 }
    : { guest_key: guestKey, plan: "free", expansions_day: day, expansions_used: 1 };

  const ins = await supabase.from("usable_limits").insert(insPayload);
  if (ins.error) return { allowed: false, hardError: ins.error.message };
  return { allowed: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const OPENAI_MODEL = process.env.EXPAND_MODEL || "gpt-4o-mini";

    const supabase = supabaseAdmin();
    const openai = new OpenAI({ apiKey });

    const body = req.body || {};

    const projectId = clean(body.projectId) || null;
    const topic = clean(body.topic);
    const audience = clean(body.audience);
    const bookTitle = clean(body.bookTitle);
    const purpose = clean(body.purpose);
    const chapterTitle = clean(body.chapterTitle);
    const chapterNumber = Number(body.chapterNumber || 0);
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);
    const minWords = Number(body.minWords || 900);
    const maxWords = Number(body.maxWords || 1300);
    const regenerate = !!body.regenerate;

    if (!chapterTitle || !topic || !chapterNumber) {
      return res.status(400).json({ error: "Missing chapterTitle, topic, or chapterNumber" });
    }

    // Identify user from Bearer token (CRITICAL)
    let userId = null;
    const token = extractAccessToken(req);
    if (token && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      const authed = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } }
      });
      const u = await authed.auth.getUser();
      userId = u?.data?.user?.id || null;
    }

    // Guest identity fallback (stable enough for rate limiting)
    const guestKey = sha256(`${getIp(req)}|${req.headers["user-agent"] || ""}`);

    // Enforce limits BEFORE spending tokens
    const kind = regenerate ? "regen" : "expand";
    const lim = await consumeExpandLimit({
      supabase,
      userId,
      guestKey,
      projectId: projectId || "no_project",
      kind
    });

    if (!lim.allowed) {
      if (lim.limitReached) return res.status(200).json({ error: "limit_reached" });
      return res.status(500).json({ error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    const voiceBlock = voiceSample
      ? `VOICE SAMPLE (match style strictly):\n${voiceSample}\n\nVOICE NOTES:\n${voiceNotes || "none"}`
      : `VOICE NOTES:\n${voiceNotes || "none"} (Keep voice human.)`;

    const prompt = `
Write a chapter draft.

Book: ${bookTitle}
Purpose: ${purpose}
Chapter ${chapterNumber}: ${chapterTitle}
Audience: ${audience}
Topic context: ${topic}

${voiceBlock}

Rules:
- Human voice only
- No AI mentions
- ${minWords}–${maxWords} words
- Headings + flow
- End with 5 reflection questions

Return JSON only:
{ "expanded": "..." }
`.trim();

    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
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

    const expanded = clean(parsed.expanded);
    if (!expanded) {
      return res.status(500).json({ error: "no_expanded_text" });
    }

    return res.status(200).json({ expanded });
  } catch (err) {
    return res.status(500).json({ error: "Expand failed", details: String(err?.message || err) });
  }
}
