// /api/outline.js
// Server-controlled limits for outlines (logged-in users only, unless your schema supports guest_key + nullable user_id)
// Returns: { projectId, title, purpose, outline } OR { error: "limit_reached" }

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const FREE_LIMITS = {
  outlines_total: 2, // set your free outline limit here
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
    .select("user_id, outlines_used")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) return { ok: false, err: existing.error.message };
  if (existing.data) return { ok: true, row: existing.data };

  const ins = await supabaseAdmin
    .from("usage_limits")
    .insert({ user_id: userId, outlines_used: 0 })
    .select("user_id, outlines_used")
    .single();

  if (ins.error) return { ok: false, err: ins.error.message };
  return { ok: true, row: ins.data };
}

async function consumeOutlineLimit({ supabaseAdmin, userId }) {
  // IMPORTANT: with your schema (user_id NOT NULL), we do NOT write usage_limits for guests.
  if (!userId) return { allowed: true, guestUnenforced: true };

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

export default async function handler(req, res) {
  // ✅ Read env vars at request-time (fixes "Missing OPENAI_API_KEY" sticking around)
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

    // (Optional) keep a stable guest fingerprint for later if you add guest_key support
    const guestKey = sha256(`${getIp(req)}|${req.headers["user-agent"] || ""}`);
    void guestKey;

    // Enforce limit BEFORE spending tokens
    const lim = await consumeOutlineLimit({ supabaseAdmin, userId });
    if (!lim.allowed) {
      if (lim.limitReached) return res.status(200).json({ error: "limit_reached" });
      return res.status(500).json({ error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    // Create project row so expand can attach
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
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }

    const title = clean(parsed.title);
    const purpose = clean(parsed.purpose);
    const outline = Array.isArray(parsed.outline) ? parsed.outline : [];

    if (!title || !purpose || !outline.length) {
      return res.status(500).json({ error: "bad_model_response" });
    }

    // Optional: persist onto projects if columns exist (won't break if they don't)
    await supabaseAdmin
      .from("projects")
      .update({ title, purpose, outline, updated_at: new Date().toISOString() })
      .eq("id", projectId);

    return res.status(200).json({ projectId, title, purpose, outline });
  } catch (err) {
    return res.status(500).json({
      error: "Outline generation failed",
      details: String(err?.message || err),
    });
  }
}
