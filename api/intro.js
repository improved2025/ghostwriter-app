// /api/intro.js
// Server-controlled intro limit (FREE: 1 total)

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, payload) {
  res.status(status).json(payload);
}

function clean(v) {
  return (v ?? "").toString().trim();
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function getGuestKey(req) {
  return sha256(
    `${req.headers["x-forwarded-for"] || req.socket.remoteAddress || ""}|${req.headers["user-agent"] || ""}`
  );
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "method_not_allowed" });
    }

    if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(res, 500, { error: "missing_env_vars" });
    }

    const body = req.body || {};
    const bookTitle = clean(body.bookTitle);
    const purpose = clean(body.purpose);
    const outline = Array.isArray(body.outline) ? body.outline : [];
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    // ─────────────────────────────
    // Identify user or guest
    // ─────────────────────────────
    let userId = null;
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      const anon = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: auth } },
        auth: { persistSession: false }
      });
      const u = await anon.auth.getUser();
      userId = u?.data?.user?.id || null;
    }

    const guestKey = userId ? null : getGuestKey(req);

    // ─────────────────────────────
    // Check usable_limits
    // ─────────────────────────────
    let q = supabase.from("usable_limits").select("*").limit(1);
    q = userId ? q.eq("user_id", userId) : q.eq("guest_key", guestKey);

    const { data: row } = await q.maybeSingle();

    if (row?.plan === "free" && (row.introductions_used || 0) >= 1) {
      return json(res, 200, { error: "limit_reached" });
    }

    if (!row) {
      await supabase.from("usable_limits").insert(
        userId
          ? { user_id: userId, plan: "free", introductions_used: 0 }
          : { guest_key: guestKey, plan: "free", introductions_used: 0 }
      );
    }

    // ─────────────────────────────
    // Generate introduction
    // ─────────────────────────────
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const system = `
You are a writing coach.
Write WITH the author, not for them.
Match tone, cadence, and voice.
No AI references. No hype.
Return JSON only.
`.trim();

    const userPrompt = {
      task: "Write a book introduction",
      bookTitle,
      purpose,
      outline,
      voiceNotes,
      voiceSample: voiceSample.slice(0, 2000),
      constraints: { minWords: 400, maxWords: 700 },
      output_schema: { introduction: "string" }
    };

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userPrompt) }
      ],
      response_format: { type: "json_object" }
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const introduction = clean(parsed.introduction);

    if (!introduction) {
      return json(res, 500, { error: "no_introduction_returned" });
    }

    // Increment usage
    await supabase.from("usable_limits").update({
      introductions_used: (row?.introductions_used || 0) + 1,
      updated_at: new Date().toISOString()
    }).match(userId ? { user_id: userId } : { guest_key: guestKey });

    return json(res, 200, { introduction });

  } catch (err) {
    return json(res, 500, { error: "server_error", details: err.message });
  }
}
