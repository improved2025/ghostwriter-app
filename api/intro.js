// /api/intro.js
// Server-controlled limits for introductions.
// Returns: { introduction: "..." } OR { error: "limit_reached" }

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_LIMITS = {
  introductions_total: 1 // Free tier: 1 intro total
};

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

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

async function consumeIntroLimit({ supabaseAdmin, userId, guestKey }) {
  // Try RPC first if you created one
  const rpcVariants = [
    { fn: "consume_usable_limit", args: { kind: "intro" } },
    { fn: "consume_usable_limit", args: { p_kind: "intro" } },
    { fn: "consume_limit", args: { kind: "intro" } },
  ];

  for (const v of rpcVariants) {
    const r = await supabaseAdmin.rpc(v.fn, v.args);
    if (!r.error) {
      if (typeof r.data === "boolean") return { allowed: r.data };
      if (r.data?.allowed !== undefined) return { allowed: !!r.data.allowed };
      if (r.data?.ok !== undefined) return { allowed: !!r.data.ok };
      return { allowed: true };
    }
  }

  // Fallback: direct usable_limits table
  let q = supabaseAdmin.from("usable_limits").select("*").limit(1);
  q = userId ? q.eq("user_id", userId) : q.eq("guest_key", guestKey);

  const existing = await q.maybeSingle();
  if (existing.error) {
    return { allowed: false, hardError: existing.error.message };
  }

  const row = existing.data;
  const plan = (row?.plan || "free").toLowerCase();

  if (plan !== "free") return { allowed: true };

  const used = Number(row?.introductions_used || 0);
  if (used >= FREE_LIMITS.introductions_total) {
    return { allowed: false, limitReached: true };
  }

  if (row) {
    const upd = await supabaseAdmin
      .from("usable_limits")
      .update({
        introductions_used: used + 1,
        updated_at: new Date().toISOString()
      })
      .eq("id", row.id);

    if (upd.error) return { allowed: false, hardError: upd.error.message };
    return { allowed: true };
  } else {
    const ins = await supabaseAdmin.from("usable_limits").insert(
      userId
        ? { user_id: userId, plan: "free", introductions_used: 1 }
        : { guest_key: guestKey, plan: "free", introductions_used: 1 }
    );

    if (ins.error) return { allowed: false, hardError: ins.error.message };
    return { allowed: true };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return json(res, 405, { error: "method_not_allowed" });
    }

    if (!OPENAI_API_KEY) return json(res, 500, { error: "Missing OPENAI_API_KEY" });
    if (!SUPABASE_URL) return json(res, 500, { error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(res, 500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const body = req.body || {};

    const bookTitle = clean(body.bookTitle);
    const purpose = clean(body.purpose);
    const outline = Array.isArray(body.outline) ? body.outline : [];
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    let userId = null;
    const accessToken = extractAccessToken(req);
    if (accessToken) {
      const authed = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || "", {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } }
      });

      const u = await authed.auth.getUser();
      userId = u?.data?.user?.id || null;
    }

    const guestKey = sha256(`${getIp(req)}|${req.headers["user-agent"] || ""}`);

    const lim = await consumeIntroLimit({ supabaseAdmin, userId, guestKey });
    if (!lim.allowed) {
      if (lim.limitReached) return json(res, 200, { error: "limit_reached" });
      return json(res, 500, { error: "limit_check_failed", details: lim.hardError });
    }

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
      constraints: {
        minWords: 400,
        maxWords: 700
      },
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
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    const introduction = clean(parsed.introduction);
    if (!introduction) {
      return json(res, 500, { error: "no_introduction_returned" });
    }

    return json(res, 200, { introduction });
  } catch (err) {
    return json(res, 500, { error: "server_error", details: String(err?.message || err) });
  }
}
