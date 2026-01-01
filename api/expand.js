import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const body = req.body || {};
  const {
    topic,
    chapterTitle,
    chapterNumber,
    bookTitle,
    purpose,
    audience,
    minWords = 900,
    maxWords = 1300
  } = body;

  if (!topic || !chapterTitle) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const guestKey = hashGuest(req);

  const { data: row } = await supabase
    .from("usable_limits")
    .select("*")
    .eq("guest_key", guestKey)
    .maybeSingle();

  if (row?.expands_used >= 2 && row?.plan === "free") {
    return res.status(200).json({ error: "limit_reached" });
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: "You are a serious writing coach." },
      {
        role: "user",
        content: `
Book: ${bookTitle}
Purpose: ${purpose}
Audience: ${audience}

Chapter ${chapterNumber}: ${chapterTitle}
Context: ${topic}

Write ${minWords}–${maxWords} words.
End with 5 reflection questions.
`
      }
    ]
  });

  const expanded = completion.choices[0].message.content?.trim();

  if (!expanded) {
    return res.status(500).json({ error: "no_expansion" });
  }

  if (row) {
    await supabase.from("usable_limits").update({
      expands_used: (row.expands_used || 0) + 1
    }).eq("id", row.id);
  } else {
    await supabase.from("usable_limits").insert({
      guest_key: guestKey,
      plan: "free",
      expands_used: 1
    });
  }

  return res.status(200).json({ expanded });
}
