import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const FREE_LIMITS = { titles_total: 1 };

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function clean(v) { return (v ?? "").toString().trim(); }

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

async function consumeTitlesLimit({ supabaseAdmin, userId, guestKey }) {
  // RPC first (if you have it)
  const rpcVariants = [
    { fn: "consume_usable_limit", args: { kind: "titles" } },
    { fn: "consume_usable_limit", args: { p_kind: "titles" } },
    { fn: "consume_limit", args: { kind: "titles" } },
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

  // Fallback table
  let q = supabaseAdmin.from("usable_limits").select("*").limit(1);
  q = userId ? q.eq("user_id", userId) : q.eq("guest_key", guestKey);

  const existing = await q.maybeSingle();
  if (existing.error) return { allowed: false, hardError: existing.error.message };

  const row = existing.data;
  const plan = (row?.plan || "free").toLowerCase();
  if (plan !== "free") return { allowed: true };

  const used = Number(row?.titles_used || 0);
  if (used >= FREE_LIMITS.titles_total) return { allowed: false, limitReached: true };

  if (row) {
    const upd = await supabaseAdmin
      .from("usable_limits")
      .update({ titles_used: used + 1, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (upd.error) return { allowed: false, hardError: upd.error.message };
    return { allowed: true };
  }

  const ins = await supabaseAdmin.from("usable_limits").insert(
    userId
      ? { user_id: userId, plan: "free", titles_used: 1 }
      : { guest_key: guestKey, plan: "free", titles_used: 1 }
  );

  if (ins.error) return { allowed: false, hardError: ins.error.message };
  return { allowed: true };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

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

    const idea = topic || currentTitle || "A helpful book idea";

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Identify user via Bearer token
    let userId = null;
    const token = extractAccessToken(req);
    if (token && SUPABASE_ANON_KEY) {
      const authed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } }
      });
      const u = await authed.auth.getUser();
      userId = u?.data?.user?.id || null;
    }

    const guestKey = sha256(`${getIp(req)}|${req.headers["user-agent"] || ""}`);

    const lim = await consumeTitlesLimit({ supabaseAdmin, userId, guestKey });
    if (!lim.allowed) {
      if (lim.limitReached) return json(res, 200, { error: "limit_reached" });
      return json(res, 500, { error: "limit_check_failed", details: lim.hardError || "unknown" });
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const system = [
      "You generate book title suggestions.",
      "Return only JSON.",
      "Titles must be punchy, clear, not generic.",
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
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}

    const titles = Array.isArray(parsed.titles)
      ? parsed.titles.map((t) => clean(t)).filter(Boolean).slice(0, 10)
      : [];

    if (!titles.length) return json(res, 500, { error: "no_titles" });

    return json(res, 200, { titles });
  } catch (err) {
    return json(res, 500, { error: "server_error", details: String(err?.message || err) });
  }
}
