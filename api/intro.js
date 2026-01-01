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

  const { bookTitle, purpose } = req.body || {};
  const guestKey = hashGuest(req);

  const { data: row } = await supabase
    .from("usable_limits")
    .select("*")
    .eq("guest_key", guestKey)
    .maybeSingle();

  if (row?.introductions_used >= 1 && row?.plan === "free") {
    return res.status(200).json({ error: "limit_reached" });
  }

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.6,
    messages: [
      { role: "system", content: "Write a human, grounded book introduction." },
      {
        role: "user",
        content: `Book title: ${bookTitle}\nPurpose: ${purpose}\n\nWrite 400–700 words.`
      }
    ]
  });

  const introduction = completion.choices[0].message.content?.trim();

  if (!introduction) {
    return res.status(500).json({ error: "no_introduction" });
  }

  if (row) {
    await supabase.from("usable_limits").update({
      introductions_used: (row.introductions_used || 0) + 1
    }).eq("id", row.id);
  } else {
    await supabase.from("usable_limits").insert({
      guest_key: guestKey,
      plan: "free",
      introductions_used: 1
    });
  }

  return res.status(200).json({ introduction });
}
