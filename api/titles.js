import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function hashGuest(req) {
  return crypto
    .createHash("sha256")
    .update((req.headers["x-forwarded-for"] || "") + (req.headers["user-agent"] || ""))
    .digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const { topic, audience, currentTitle } = req.body || {};
  const idea = topic || currentTitle || "A meaningful book idea";

  const guestKey = hashGuest(req);

  const { data: row } = await supabase
    .from("usable_limits")
    .select("*")
    .eq("guest_key", guestKey)
    .maybeSingle();

  if (row?.titles_used >= 1 && row?.plan === "free") {
    return res.status(200).json({ error: "limit_reached" });
  }

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: "Generate 10 clear, non-clickbait book titles." },
      { role: "user", content: `Idea: ${idea}\nAudience: ${audience || "general"}` }
    ]
  });

  const raw = completion.choices[0].message.content || "";
  const titles = raw
    .split("\n")
    .map(t => t.replace(/^\d+[\).\s-]*/, "").trim())
    .filter(Boolean)
    .slice(0, 10);

  if (!titles.length) {
    return res.status(500).json({ error: "no_titles" });
  }

  if (row) {
    await supabase.from("usable_limits").update({
      titles_used: (row.titles_used || 0) + 1
    }).eq("id", row.id);
  } else {
    await supabase.from("usable_limits").insert({
      guest_key: guestKey,
      plan: "free",
      titles_used: 1
    });
  }

  return res.status(200).json({ titles });
}
