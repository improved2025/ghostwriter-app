import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // REQUIRED for server enforcement
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const body = req.body || {};
    const clean = (v) => (v ?? "").toString().trim();

    const {
      projectId,
      bookTitle,
      purpose,
      chapterNumber,
      chapterTitle,
      topic,
      audience,
      voiceSample,
      voiceNotes,
      regenerate,
      draftLength,
      minWords,
      maxWords
    } = body;

    if (!projectId || !chapterTitle) {
      return res.status(400).json({ error: "Missing projectId or chapterTitle" });
    }

    // 1️⃣ Load project + usage
    const { data: project, error } = await supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .single();

    if (error || !project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const plan = project.plan || "free";
    const expandedCount = project.expanded_count || 0;
    const regenCount = project.regeneration_count || 0;

    // 2️⃣ Enforce limits BEFORE OpenAI
    if (plan === "free") {
      return res.status(403).json({ error: "limit_reached" });
    }

    if (plan === "single") {
      if (expandedCount >= 12) {
        return res.status(403).json({ error: "limit_reached" });
      }
      if (regenerate && regenCount >= 12) {
        return res.status(403).json({ error: "limit_reached" });
      }
      if (draftLength === "very_long") {
        return res.status(403).json({ error: "upgrade_required" });
      }
    }

    if (plan === "lifetime") {
      if (expandedCount >= 20) {
        return res.status(403).json({ error: "limit_reached" });
      }
      if (regenCount >= 40) {
        return res.status(403).json({ error: "limit_reached" });
      }
    }

    // 3️⃣ Build prompt (voice-aware)
    const prompt = `
You are a book coach writing WITH the author, not for them.

BOOK TITLE:
${bookTitle}

PURPOSE:
${purpose}

CHAPTER ${chapterNumber}:
${chapterTitle}

AUDIENCE:
${audience}

TOPIC:
${topic}

AUTHOR VOICE SAMPLE:
${voiceSample || "None provided"}

AUTHOR VOICE NOTES:
${voiceNotes || "Write naturally, human, non-robotic."}

RULES:
- Match the author's voice, rhythm, and tone strictly
- Do NOT sound generic or AI-written
- ${minWords}–${maxWords} words
- Clear headings
- Practical and grounded
- End with 5 reflection questions

Return JSON ONLY:
{ "expanded": "..." }
`.trim();

    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a professional book coach." },
        { role: "user", content: prompt }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { expanded: raw };
    }

    if (!parsed.expanded) {
      throw new Error("No expanded content returned");
    }

    // 4️⃣ Update usage counters
    const updates = {
      expanded_count: expandedCount + 1
    };

    if (regenerate) {
      updates.regeneration_count = regenCount + 1;
    }

    await supabase
      .from("projects")
      .update(updates)
      .eq("id", projectId);

    return res.status(200).json({ expanded: parsed.expanded });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
