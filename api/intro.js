// /api/intro.js
// Server-controlled introduction limit (FREE: 1 total)

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function clean(v) {
  return (v ?? "").toString().trim();
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function getGuestKey(req) {
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "";
  const ua = (req.headers["user-agent"] || "").toString();
  return sha256(`${ip}|${ua}`);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "missing_env_vars" });
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

    // Identify user if Authorization Bearer exists
    let userId = null;
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && process.env.SUPABASE_ANON_KEY) {
      const anon = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: auth } },
        auth: { persistSession: false }
      });

      const u = await anon.auth.getUser();
      userId = u?.data?.user?.id || null;
    }

    const guestKey = userId ? null : getGuestKey(req);

    // Read usable_limits row
    let q = supabase.from("usable_limits").select("*").limit(1);
    q = userId ? q.eq("user_id", userId) : q.eq("guest_key", guestKey);

    const { data: row, error: readErr } = await q.maybeSingle();
    if (readErr) {
      return res.status(500).json({ error: "limit_check_failed", details: readErr.message });
    }

    // Free plan enforcement: 1 total intro
    const plan = (row?.plan || "free").toString().toLowerCase();
    const used = Number(row?.introductions_used || 0);

    if (plan === "free" && used >= 1) {
      return res.status(200).json({ error: "limit_reached" });
    }

    // Ensure row exists (so updates always succeed)
    if (!row) {
      const ins = await supabase.from("usable_limits").insert(
        userId
          ? { user_id: userId, plan: "free", introductions_used: 0 }
          : { guest_key: guestKey, plan: "free", introductions_used: 0 }
      );
      if (ins.error) {
        return res.status(500).json({ error: "limit_check_failed", details: ins.error.message });
      }
    }

    // Generate introduction
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const system = `
You are a writing coach.
You write WITH the author, not for them.
Match their tone and cadence.
No AI references. No hype.
Clear, human, grounded.
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

    const introduction = clean(parsed.introduction);
    if (!introduction) return res.status(500).json({ error: "no_introduction_returned" });

    // Increment usage
    await supabase
      .from("usable_limits")
      .update({
        introductions_used: used + 1,
        updated_at: new Date().toISOString()
      })
      .match(userId ? { user_id: userId } : { guest_key: guestKey });

    return res.status(200).json({ introduction });

  } catch (err) {
    return res.status(500).json({ error: "server_error", details: String(err?.message || err) });
  }
}
