// /api/outline.js
// Server-controlled limits for "Generate starting point" (outline).
// Uses: public.usage_limits
// Increments: outlines_used
// Creates a projects row and returns projectId so expand can attach to it.
// Returns: { projectId, title, purpose, outline } OR { error: "limit_reached" }

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Free tier policy (server truth)
const FREE_LIMITS = {
  outlines_total: 2, // change to whatever you want
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
  const bodyUserId = clean(body?.userId);
  if (bodyUserId) return bodyUserId;

  const token = extractAccessToken(req);
  if (!token) return null;

  const u = await supabaseAdmin.auth.getUser(token);
  return u?.data?.user?.id || null;
}

async function ensureUsageRowByUser({ supabaseAdmin, userId }) {
  const existing = await supabaseAdmin
    .from("usage_limits")
    .select("user_id, titles_used, outlines_used, expands_used")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) return { ok: false, err: existing.error.message };
  if (existing.data) return { ok: true, row: existing.data };

  const ins = await supabaseAdmin
    .from("usage_limits")
    .insert({ user_id: userId, titles_used: 0, outlines_used: 0, expands_used: 0 })
    .select("user_id, titles_used, outlines_used, expands_used")
    .single();

  if (ins.error) return { ok: false, err: ins.error.message };
  return { ok: true, row: ins.data };
}

// Optional: if you added guest_key to usage_limits, this enforces guests too.
// If you did NOT add guest_key, guests are allowed (but logged-in users are still enforced).
async function ensureUsageRowByGuest({ supabaseAdmin, guestKey }) {
  const existing = await supabaseAdmin
    .from("usage_limits")
    .select("guest_key, titles_used, outlines_used, expands_used")
    .eq("guest_key", guestKey)
    .maybeSingle();

  if (existing.error) {
    // Most common: column "guest_key" does not exist
    return { ok: false, err: existing.error.message, guestColumnMissing: true };
  }
  if (existing.data) return { ok: true, row: existing.data };

  const ins = await supabaseAdmin
    .from("usage_limits")
    .insert({ guest_key: guestKey, titles_used: 0, outlines_used: 0, expands_used: 0 })
    .select("guest_key, titles_used, outlines_used, expands_used")
    .single();

  if (ins.error) return { ok: false, err: ins.error.message };
  return { ok: true, row: ins.data };
}

async function consumeOutlineLimit({ supabaseAdmin, userId, guestKey }) {
  // Logged-in: enforce with user_id
  if (userId) {
    const ensured = await ensureUsageRowByUser({ supabaseAdmin, userId });
    if (!ensured.ok) return { allowed: false, hardError: ensured.err };

    const used = Number(ensured.row?.outlines_used || 0);
    if (used >= FREE_LIMITS.outlines_total) return { allowed: false, limitReached: true };

    const upd = await supabaseAdmin
      .from("usage_limits")
      .update({ outlines_used: used + 1, updated_at: new Date().toISOString() })
      .eq("user_id", userId);

    if (upd.error) return { allowed: false, hardError: upd.error.message };
    return { allowed: true };
  }

  // Guest: enforce only if guest_key column exists
  const ensuredGuest = await ensureUsageRowByGuest({ supabaseAdmin, guestKey });
  if (!ensuredGuest.ok) {
    if (ensuredGuest.guestColumnMissing) return { allowed: true, guestUnenforced: true };
    return { allowed: false, hardError: ensuredGuest.err };
  }

  const used = Number(ensuredGuest.row?.outlines_used || 0);
  if (used >= FREE_LIMITS.outlines_total) return { allowed: false, limitReached: true };

  const upd = await supabaseAdmin
    .from("usage_limits")
    .update({ outlines_used: used + 1, updated_at: new Date().toISOString() })
    .eq("guest_key", guestKey);

  if (upd.error) return { allowed: false, hardError: upd.error.message };
  return { allowed: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    if (!SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const body = req.body || {};

    const topic = clean(body.topic);
    const audience = clean(body.audience) || "general readers";
    const blocker = clean(body.blocker) || "none";
    const chapters = Number(body.chapters) || 12;

    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    if (!topic) return res.status(400).json({ error: "Missing topic" });

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const userId = await getUserId({ supabaseAdmin, req, body });

    const guestKey = sha256(`${getIp(req)}|${req.headers["user-agent"] || ""}`);

    // Consume limit BEFORE spending tokens
    const lim = await consumeOutlineLimit({ supabaseAdmin, userId, guestKey });
    if (!lim.allowed) {
      if (lim.limitReached) return res.status(200).json({ error: "limit_reached" });
      return res.status(500).json({ error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    // Create project row NOW so expand can attach and you can track usage
    const { data: proj, error: projErr } = await supabaseAdmin
      .from("projects")
      .insert({
        user_id: userId || null,
        topic,
        audience,
        blocker,
        chapters,
        is_paid: false,
      })
      .select("id")
      .single();

    if (projErr) {
      return res.status(500).json({ error: "could not create project row in supabase", details: projErr });
    }

    const projectId = proj?.id || null;

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    const system = `
You are a professional book coach.
Return ONLY valid JSON. No markdown. No commentary.

Schema:
{
  "title": "string",
  "purpose": "string",
  "outline": [
    { "chapter": 1, "title": "string", "bullets": ["string","string","string"] }
  ]
}

Rules:
- Outline length must equal chapters requested
- Chapters start at 1 and are sequential
- Bullets: 3–5 per chapter
- Practical, human, non-robotic
`.trim();

    const voiceBlock = voiceSample
      ? `VOICE SAMPLE (match tone and phrasing strictly):
${voiceSample}

VOICE NOTES:
${voiceNotes || "none"}`
      : `VOICE NOTES:
${voiceNotes || "none"} (Keep voice natural and human.)`;

    const user = `
Topic: ${topic}
Audience: ${audience}
Main blocker: ${blocker}
Chapters requested: ${chapters}

${voiceBlock}

Create a clear starter outline that helps the user write.
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      data = {};
    }

    const title = clean(data.title);
    const purpose = clean(data.purpose);
    const outline = Array.isArray(data.outline) ? data.outline : [];

    if (!title || !purpose || !outline.length) {
      return res.status(500).json({ error: "bad_model_response" });
    }

    // Optional: store generated outline back on the project row (safe if columns exist)
    // If your projects table doesn't have these columns, this update will fail silently.
    await supabaseAdmin
      .from("projects")
      .update({
        title,
        purpose,
        outline,
        updated_at: new Date().toISOString(),
      })
      .eq("id", projectId);

    return res.status(200).json({
      projectId,
      title,
      purpose,
      outline,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Outline generation failed",
      details: String(err?.message || err),
    });
  }
}
