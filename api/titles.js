// /api/titles.js
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_LIMITS = { titles_total: 1 };

const clean = (v) => (v ?? "").toString().trim();
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const guestKey = sha256(`${req.headers["x-forwarded-for"] || ""}|${req.headers["user-agent"] || ""}`);

  const { data } = await supabase
    .from("usable_limits")
    .select("*")
    .eq("guest_key", guestKey)
    .maybeSingle();

  const used = Number(data?.titles_used || 0);
  const plan = (data?.plan || "free").toLowerCase();

  if (plan === "free" && used >= FREE_LIMITS.titles_total) {
    return res.status(200).json({ error: "limit_reached" });
  }

  if (data) {
    await supabase.from("usable_limits")
      .update({ titles_used: used + 1 })
      .eq("id", data.id);
  } else {
    await supabase.from("usable_limits")
      .insert({ guest_key: guestKey, titles_used: 1, plan: "free" });
  }

  const client = new OpenAI({ apiKey: OPENAI_API_KEY });
  const { topic, audience, currentTitle } = req.body;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: "Generate 10 book titles. JSON only." },
      {
        role: "user",
        content: JSON.stringify({
          idea: topic || currentTitle || "Book idea",
          audience
        })
      }
    ],
    response_format: { type: "json_object" }
  });

  const parsed = JSON.parse(resp.choices[0].message.content || "{}");
  if (!Array.isArray(parsed.titles)) {
    return res.status(500).json({ error: "no_titles" });
  }

  return res.status(200).json({ titles: parsed.titles.slice(0, 10) });
}
