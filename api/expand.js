// /api/expand.js
import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase.js";

const FREE_EXPANDS = 2;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const supabase = supabaseAdmin();

    const {
      projectId,
      userId,
      topic,
      audience,
      bookTitle,
      purpose,
      chapterTitle,
      chapterNumber,
      voiceSample,
      voiceNotes,
      minWords = 900,
      maxWords = 1300,
      regenerate = false
    } = req.body;

    if (!chapterTitle || !topic) {
      return res.status(400).json({ error: "Missing chapterTitle or topic" });
    }

    let pid = projectId;

    if (!pid) {
      const { data, error } = await supabase
        .from("projects")
        .insert({ user_id: userId || null, topic, audience })
        .select("id")
        .single();

      if (error) return res.status(500).json({ error: "project_create_failed" });
      pid = data.id;
    }

    // 🔒 HARD LIMIT ENFORCEMENT
    const { data: usage } = await supabase
      .from("usable_limits")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    const used = Number(usage?.expands_used || 0);
    const plan = (usage?.plan || "free").toLowerCase();

    if (plan === "free" && used >= FREE_EXPANDS) {
      return res.status(200).json({ error: "limit_reached" });
    }

    if (usage) {
      await supabase
        .from("usable_limits")
        .update({ expands_used: used + 1 })
        .eq("id", usage.id);
    } else {
      await supabase
        .from("usable_limits")
        .insert({ user_id: userId, expands_used: 1, plan: "free" });
    }

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: "Write WITH the author. JSON only." },
        {
          role: "user",
          content: `
Book: ${bookTitle}
Purpose: ${purpose}
Chapter ${chapterNumber}: ${chapterTitle}
Audience: ${audience}
Topic: ${topic}

Voice:
${voiceSample || ""}
${voiceNotes || ""}

${minWords}-${maxWords} words.
End with 5 reflection questions.

Return JSON:
{ "expanded": "..." }
`
        }
      ],
      response_format: { type: "json_object" }
    });

    const parsed = JSON.parse(resp.choices[0].message.content || "{}");
    if (!parsed.expanded) {
      return res.status(500).json({ error: "no_expansion" });
    }

    return res.status(200).json({ projectId: pid, expanded: parsed.expanded });

  } catch (err) {
    return res.status(500).json({ error: "expand_failed", details: err.message });
  }
}
