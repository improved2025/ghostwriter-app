import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });

    const openai = new OpenAI({ apiKey });

    const body = req.body || {};
    const clean = (v) => (v ?? "").toString().trim();

    const bookTitle = clean(body.bookTitle);
    const purpose = clean(body.purpose);
    const chapterTitle = clean(body.chapterTitle);
    const chapterNumber = Number.isFinite(parseInt(body.chapterNumber, 10)) ? parseInt(body.chapterNumber, 10) : null;

    // Optional context from start.html
    const topic = clean(body.topic);
    const audience = clean(body.audience);

    // NEW: voice capture (optional)
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    // NEW: regenerate flag (optional)
    const regenerate = Boolean(body.regenerate);

    if (!chapterTitle) {
      return res.status(400).json({ error: "Missing chapterTitle" });
    }

    const system = `
You are Authored, a writing partner and book coach.
You do NOT write for the user. You write WITH the user.

Primary goal:
- Create a chapter draft that sounds human and sounds like the user (if voice sample exists).

Rules:
- No mention of AI or ChatGPT.
- No hype, no generic filler.
- Use clear headings and natural transitions.
- 900 to 1300 words.
- End with 5 reflection questions.
- If a voice sample is provided, match its tone, rhythm, and word choice (without copying lines).
- If regenerate=true, produce a noticeably different version while keeping the same chapter intent and structure.
Return ONLY valid JSON (no markdown, no commentary) in this format:
{ "expanded": "..." }
`.trim();

    const user = `
Book title: ${bookTitle || "Untitled"}
Purpose: ${purpose || "N/A"}
Topic: ${topic || "N/A"}
Audience: ${audience || "General readers"}
Chapter number: ${chapterNumber || "N/A"}
Chapter title: ${chapterTitle}

VOICE SAMPLE (if provided, match it):
${voiceSample ? voiceSample : "[No sample provided]"}

VOICE NOTES (if provided, follow them):
${voiceNotes ? voiceNotes : "[No notes provided]"}

Task:
Write the expanded draft for this chapter.

${regenerate ? "Regenerate request: write a new take that feels fresh (new examples, new phrasing), but still fits the same chapter title and purpose." : ""}
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: regenerate ? 0.75 : 0.65,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    });

    const content = resp?.choices?.[0]?.message?.content || "";
    let data;

    try {
      data = JSON.parse(content);
    } catch (e) {
      return res.status(500).json({
        error: "OpenAI returned non-JSON. Update prompt or model.",
        raw: content.slice(0, 2000)
      });
    }

    const expanded = clean(data?.expanded);
    if (!expanded) {
      return res.status(500).json({ error: "No expanded text returned" });
    }

    return res.status(200).json({ expanded });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
