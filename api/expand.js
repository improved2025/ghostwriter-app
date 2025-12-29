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

    const topic = clean(body.topic);
    const audience = clean(body.audience);

    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    const regenerate = Boolean(body.regenerate);

    // Draft length support (optional)
    const minWords = Number.isFinite(parseInt(body.minWords, 10)) ? parseInt(body.minWords, 10) : 900;
    const maxWords = Number.isFinite(parseInt(body.maxWords, 10)) ? parseInt(body.maxWords, 10) : 1300;

    if (!chapterTitle) return res.status(400).json({ error: "Missing chapterTitle" });

    const system = `
You are Authored, a writing partner and book coach.
NON-NEGOTIABLE: You do NOT write for the user. You write WITH the user in the user's voice.

STRICT VOICE ENFORCEMENT
1) If a voice sample is provided, mirror it. Match:
   - sentence rhythm and length tendency
   - formality level
   - vocabulary choices
   - emotional temperature
   - spiritual register (if present)
2) You MUST NOT drift into generic assistant tone.
3) You MUST NOT use clichés, hype, or motivational filler.
4) You MUST NOT mention AI, ChatGPT, "as an assistant", or "I can help you".
5) You MUST NOT copy sentences from the sample. Mimic style only.

CHAPTER DRAFT RULES
- Use clear headings.
- Hit the target word range: ${minWords}–${maxWords} words.
- Provide practical examples and concrete explanation.
- End with EXACTLY 5 reflection questions (bulleted).
- If regenerate=true: write a noticeably different version (new examples, new phrasing, fresh structure) while staying faithful to the chapter intent.

OUTPUT RULES
Return ONLY valid JSON (no markdown, no commentary) in this exact format:
{ "expanded": "..." }

FINAL SELF-CHECK (INTERNAL)
Before returning JSON, verify:
- Voice matches sample (if provided)
- No banned phrases appear
- No lines are copied from the sample
- Word count is within range (approximate is fine)
If any check fails, rewrite before returning JSON.
`.trim();

    const user = `
BOOK TITLE: ${bookTitle || "Untitled"}
PURPOSE: ${purpose || "N/A"}
TOPIC: ${topic || "N/A"}
AUDIENCE: ${audience || "General readers"}
CHAPTER: ${chapterNumber || "N/A"}: ${chapterTitle}
TARGET WORD RANGE: ${minWords}–${maxWords}
REGENERATE: ${regenerate ? "true" : "false"}

VOICE NOTES:
${voiceNotes || "none"}

VOICE SAMPLE:
${voiceSample || "none"}

Task:
Write the expanded chapter draft in the user's voice.
Make it feel human, personal, and natural — like the user wrote it.
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
    } catch {
      return res.status(500).json({
        error: "OpenAI returned non-JSON. Update prompt or model.",
        raw: content.slice(0, 2000)
      });
    }

    const expanded = clean(data?.expanded);
    if (!expanded) return res.status(500).json({ error: "No expanded text returned" });

    return res.status(200).json({ expanded });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
