import OpenAI from "openai";
import { supabaseAdmin } from "./_supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });

    const openai = new OpenAI({ apiKey });
    const supabase = supabaseAdmin();

    const body = req.body || {};
    const clean = (v) => (v ?? "").toString().trim();

    const projectId = clean(body.projectId);
    const chapterTitle = clean(body.chapterTitle);

    const bookTitle = clean(body.bookTitle) || "Untitled";
    const purpose = clean(body.purpose) || "N/A";
    const chapterNumber = Number.isFinite(parseInt(body.chapterNumber, 10)) ? parseInt(body.chapterNumber, 10) : null;

    const topic = clean(body.topic) || "";
    const audience = clean(body.audience) || "";
    const voiceSample = clean(body.voiceSample) || "";
    const voiceNotes = clean(body.voiceNotes) || "";

    const regenerate = !!body.regenerate;
    const minWords = Number.isFinite(parseInt(body.minWords, 10)) ? parseInt(body.minWords, 10) : 900;
    const maxWords = Number.isFinite(parseInt(body.maxWords, 10)) ? parseInt(body.maxWords, 10) : 1300;

    // Optional: pass userId from client when logged in
    let userId = clean(body.userId) || null;

    if (!projectId || !chapterTitle) {
      return res.status(400).json({ error: "Missing projectId or chapterTitle" });
    }

    // If userId not provided, try to read it from the project row
    if (!userId) {
      const { data: proj, error: projErr } = await supabase
        .from("projects")
        .select("user_id, is_paid")
        .eq("id", projectId)
        .single();

      if (projErr) {
        return res.status(500).json({ error: "Failed to read project", details: projErr });
      }
      userId = proj?.user_id || null;

      // If project is guest (no user_id), block expand for now (strong protection)
      if (!userId) {
        return res.status(403).json({ error: "auth_required" });
      }
    }

    // Enforce limit (regen counts as expand)
    const kind = regenerate ? "regen" : "expand";
    const { data: limitData, error: limitErr } = await supabase.rpc("consume_limit", {
      p_user_id: userId,
      p_project_id: projectId,
      p_kind: kind,
    });

    if (limitErr) {
      return res.status(500).json({ error: "limit_check_failed", details: limitErr });
    }

    if (!limitData?.allowed) {
      return res.status(403).json({ error: "limit_reached", reason: limitData?.reason || null });
    }

    const voiceBlock = voiceSample
      ? `VOICE SAMPLE (match tone, cadence, phrasing; avoid generic AI voice):
${voiceSample}

VOICE NOTES:
${voiceNotes || "none"}`
      : `VOICE NOTES:
${voiceNotes || "none"} (Keep voice natural and human; avoid robotic phrasing.)`;

    const prompt = `
You are a strict book coach.
Write an expanded draft for ONE chapter.

Book title: ${bookTitle}
Purpose: ${purpose}
Chapter ${chapterNumber || ""}: ${chapterTitle}
Topic context: ${topic}
Audience: ${audience}

${voiceBlock}

Rules:
- Do NOT mention AI/ChatGPT.
- Write like a human, in the user's voice.
- Use clear headings.
- Target length: ${minWords} to ${maxWords} words.
- End with 5 bullet reflection questions.

Return JSON only:
{ "expanded": "..." }
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: "You are a strict book coach who matches the user's voice." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const text = resp?.choices?.[0]?.message?.content || "";
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { parsed = { expanded: text }; }

    const expanded = (parsed?.expanded || "").toString().trim();
    if (!expanded) return res.status(500).json({ error: "No expanded text returned" });

    return res.status(200).json({ expanded });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
