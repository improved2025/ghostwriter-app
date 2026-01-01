// /api/titles.js
// Server-controlled limits for title suggestions.
// Returns: { titles: [...] } OR { error: "limit_reached" }

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Free tier policy (server truth)
const FREE_LIMITS = {
  titles_total: 1, // 1 total title suggestions on free
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

/**
 * Try to extract a Supabase access token (for logged-in users) from:
 * - Authorization: Bearer <token>
 * - Cookies: sb-access-token or supabase-auth-token
 */
function extractAccessToken(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/Bearer\s+(.+)/i);
  if (m?.[1]) return m[1].trim();

  const cookie = req.headers.cookie || "";

  // sb-access-token=<token>
  const sbAccess = cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
  if (sbAccess?.[1]) return decodeURIComponent(sbAccess[1]);

  // supabase-auth-token=["access","refresh"]
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

/**
 * Consume 1 unit of "titles_total" for this identity.
 * Preference:
 * 1) If you already created an RPC for usable_limits, we try it first (most reliable).
 * 2) Otherwise, we fall back to direct table updates on `usable_limits`.
 *
 * Expected fallback table shape (adjust if yours differs):
 * - usable_limits: id (uuid pk) OR user_id (uuid unique) OR guest_key (text unique)
 * - plan (text) default 'free'
 * - titles_used (int) default 0
 */
async function consumeTitlesLimit({ supabaseAdmin, userId, guestKey }) {
  // ---------- 1) Try RPC (if you have one) ----------
  const rpcVariants = [
    { fn: "consume_usable_limit", args: { kind: "titles" } },
    { fn: "consume_usable_limit", args: { p_kind: "titles" } },
    { fn: "consume_usable_limit", args: { action: "titles" } },
    { fn: "consume_usable_limit", args: { p_action: "titles" } },
    { fn: "consume_limit", args: { kind: "titles" } },
    { fn: "consume_limit", args: { p_kind: "titles" } },
  ];

  for (const v of rpcVariants) {
    const r = await supabaseAdmin.rpc(v.fn, v.args);
    if (!r.error) {
      // Supported shapes:
      // - boolean (true = allowed)
      // - { allowed: true/false }
      // - { ok: true/false }
      if (typeof r.data === "boolean") return { allowed: r.data };
      if (r.data?.allowed !== undefined) return { allowed: !!r.data.allowed };
      if (r.data?.ok !== undefined) return { allowed: !!r.data.ok };
      // If it ran without error but returned something unexpected, assume allowed
      return { allowed: true };
    }
  }

  // ---------- 2) Fallback: direct table enforcement ----------
  // Identify row key
  const isUser = !!userId;

  // Try to read existing limits row
  let q = supabaseAdmin.from("usable_limits").select("*").limit(1);
  q = isUser ? q.eq("user_id", userId) : q.eq("guest_key", guestKey);

  const existing = await q.maybeSingle();
  if (existing.error) {
    return {
      allowed: false,
      hardError: `usable_limits read failed: ${existing.error.message}`,
    };
  }

  const row = existing.data;

  const plan = (row?.plan || "free").toString().toLowerCase();
  if (plan !== "free") {
    // Paid: allow
    return { allowed: true };
  }

  const titlesUsed = Number(row?.titles_used || 0);
  if (titlesUsed >= FREE_LIMITS.titles_total) {
    return { allowed: false, limitReached: true };
  }

  // Update existing row, or create one if missing
  if (row) {
    const upd = await supabaseAdmin
      .from("usable_limits")
      .update({ titles_used: titlesUsed + 1, updated_at: new Date().toISOString() })
      .eq("id", row.id);

    if (upd.error) {
      return {
        allowed: false,
        hardError: `usable_limits update failed: ${upd.error.message}`,
      };
    }
    return { allowed: true };
  } else {
    // Insert a fresh limits row for this identity
    const insPayload = isUser
      ? { user_id: userId, plan: "free", titles_used: 1 }
      : { guest_key: guestKey, plan: "free", titles_used: 1 };

    const ins = await supabaseAdmin.from("usable_limits").insert(insPayload);
    if (ins.error) {
      return {
        allowed: false,
        hardError: `usable_limits insert failed: ${ins.error.message}`,
      };
    }
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
    const topic = clean(body.topic);
    const audience = clean(body.audience);
    const blocker = clean(body.blocker);
    const currentTitle = clean(body.currentTitle);
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    // Titles can still be generated even if topic is short,
    // but give the model something.
    const idea = topic || currentTitle || "A helpful book idea";

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Identify user (if logged in). Otherwise use a stable guest fingerprint.
    let userId = null;
    const accessToken = extractAccessToken(req);
    if (accessToken) {
      const authed = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || "", {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });

      const u = await authed.auth.getUser();
      userId = u?.data?.user?.id || null;
    }

    const guestKey = sha256(`${getIp(req)}|${req.headers["user-agent"] || ""}`);

    // Consume limit BEFORE spending tokens
    const lim = await consumeTitlesLimit({ supabaseAdmin, userId, guestKey });
    if (!lim.allowed) {
      if (lim.limitReached) return json(res, 200, { error: "limit_reached" });
      // Hard error means schema/RPC mismatch – show details so you can fix fast
      return json(res, 500, { error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const system = [
      "You generate book title suggestions.",
      "Return only JSON, no extra text.",
      "Titles must be punchy, clear, and not generic.",
      "Avoid clickbait. Avoid overly long titles.",
    ].join(" ");

    const user = {
      task: "Generate 10 title suggestions",
      idea,
      audience,
      blocker,
      currentTitle,
      voiceNotes,
      voiceSample_snippet: voiceSample ? voiceSample.slice(0, 1800) : "",
      output_schema: { titles: ["string"] },
    };

    const resp = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
      response_format: { type: "json_object" },
    });

    const raw = resp.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    const titles = Array.isArray(parsed.titles)
      ? parsed.titles.map((t) => clean(t)).filter(Boolean).slice(0, 10)
      : [];

    if (!titles.length) {
      return json(res, 500, { error: "no_titles_returned" });
    }

    return json(res, 200, { titles });
  } catch (err) {
    return json(res, 500, { error: "server_error", details: String(err?.message || err) });
  }
}
