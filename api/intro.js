// /api/intro.js
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_LIMITS = { introductions_total: 1 };

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

const clean = (v) => (v ?? "").toString().trim();
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function getIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "0.0.0.0";
}

async function consumeIntroLimit({ supabase, userId, guestKey }) {
  let q = supabase.from("usable_limits").select("*").limit(1);
  q = userId ? q.eq("user_id", userId) : q.eq("guest_key", guestKey);

  const { data } = await q.maybeSingle();
  const used = Number(data?.introductions_used || 0);
  const plan = (data?.plan || "free").toLowerCase();

  if (plan !== "free") return { allowed: true };
  if (used >= FREE_LIMITS.introductions_total) return { allowed: false };

  if (data) {
    await supabase
      .from("usable_limits")
      .update({ introductions_used: used + 1 })
      .eq("id", data.id);
  } else {
    await supabase.from("usable_limits").insert(
      userId
        ? { user_id: userId, introductions_used: 1, plan: "free" }
        : { guest_key: guestKey, introductions_used: 1, plan: "free" }
    );
  }

  return { allowed: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const guestKey = sha256(`${getIp(req)}|${req.headers["user-agent"] || ""}`);
  const userId = null; // handled via cookie/session if needed later

  const lim = await consumeIntroLimit({ supabase, userId, guestKey });
  if (!lim.allowed) return json(res, 200, { error: "limit_reached" });

  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  const { bookTitle, purpose, outline, voiceSample, voiceNotes } = req.body;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.6,
    messages: [
      { role: "system", content: "Write WITH the author. Return JSON only." },
      {
        role: "user",
        content: JSON.stringify({
          task: "Book introduction",
          bookTitle,
          purpose,
          outline,
          voiceNotes,
          voiceSample,
          minWords: 400,
          maxWords: 700
        })
      }
    ],
    response_format: { type: "json_object" }
  });

  const parsed = JSON.parse(resp.choices[0].message.content || "{}");
  if (!parsed.introduction) return json(res, 500, { error: "no_introduction" });

  return json(res, 200, { introduction: parsed.introduction });
}
