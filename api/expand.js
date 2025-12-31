import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const openai = new OpenAI({ apiKey });
    const supabase = supabaseAdmin();

    const body = req.body || {};
    const clean = (v) => (v ?? "").toString().trim();

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
    } = body;

    if (!chapterTitle || !topic) {
      return res.status(400).json({ error: "Missing chapterTitle or topic" });
    }

    let pid = projectId;

    // Create project ONLY HERE (first paid / limited action)
    if (!pid) {
      const { data: proj, error } = await supabase
        .from("projects")
        .insert({
          user_id: userId || null,
          topic,
          audience,
          chapters: null,
          is_paid: false
        })
        .select("id")
        .single();

      if (error) {
        return res.status(500).json({ error: "Failed to create project", details: error });
      }

      pid = proj.id;
    }

    // Enforce limits
    if (userId) {
      const kind = regenerate ? "regen" : "expand";
      const { data: limit } = await supabase.rpc("consume_limit", {
        p_user_id: userId,
        p_project_id: pid,
        p_kind: kind
      });

      if (!limit?.allowed) {
        return res.status(403).json({ error: "limit_reached" });
      }
    }

    const voiceBlock = voiceSample
      ? `VOICE SAMPLE (match style strictly):
${voiceSample}

VOICE NOTES:
${voiceNotes || "none"}`
      : `VOICE NOTES:
${voiceNotes || "none"} (Keep voice human.)`;

    const prompt = `
Write a chapter draft.

Book: ${bookTitle}
Purpose: ${purpose}
Chapter ${chapterNumber}: ${chapterTitle}
Audience: ${audience}
Topic context: ${topic}

${voiceBlock}

Rules:
- Human voice only
- No AI mentions
- ${minWords}–${maxWords} words
- Headings + flow
- End with 5 reflection questions

Return JSON only:
{ "expanded": "..." }
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a strict writing coach." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    const parsed = JSON.parse(resp.choices[0].message.content);

    return res.status(200).json({
      projectId: pid,
      expanded: parsed.expanded
    });

  } catch (err) {
    return res.status(500).json({
      error: "Expand failed",
      details: err.message
    });
  }
}
