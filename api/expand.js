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

    // Start.html sends these
    const draftLength = clean(body.draftLength) || "standard";
    const minWords = Number.isFinite(parseInt(body.minWords, 10)) ? parseInt(body.minWords, 10) : 900;
    const maxWords = Number.isFinite(parseInt(body.maxWords, 10)) ? parseInt(body.maxWords, 10) : 1300;

    const regenerate = !!body.regenerate;

    if (!chapterTitle) return res.status(400).json({ error: "Missing chapterTitle" });

    const system = `
You are Authored: a book coach and writing partner.
You are NOT writing the user's book for them.
You are helping them produce a draft they can edit and claim as their own.

Hard rules:
- Match the user's voice when a sample is provided.
- Natural human writing only. No robotic phrasing.
- No AI mentions. No disclaimers. No filler.
- Use clear headings.
- Stay practical and specific.
- Maintain internal consistency with the book title, purpose, and chapter title.

Return ONLY valid JSON in EXACT format:
{ "expanded": "..." }
`.trim();

    const voiceBlock = `
VOICE REQUIREMENTS (STRICT):
- If writing sample exists: mirror cadence, sentence length, vocabulary, and tone.
- Keep it sounding like the SAME person.
- Avoid generic self-help voice unless the sample is self-help.
- Avoid corporate/marketing language.
- Use the user's preferred style notes.

Voice Notes:
${voiceNotes || "(none)"}

User Writing Sample:
${voiceSample ? `"""${voiceSample}"""` : "(none provided)"}
`.trim();

    const user = `
BOOK CONTEXT
Title: ${bookTitle || "Untitled"}
Purpose: ${purpose || "N/A"}
Topic: ${topic || "N/A"}
Audience: ${audience || "general readers"}

CHAPTER TO DRAFT
Chapter Number: ${chapterNumber ?? "N/A"}
Chapter Title: ${chapterTitle}

DRAFT SETTINGS
Mode: ${regenerate ? "regenerate" : "expand"}
Target length: ${draftLength} (${minWords}–${maxWords} words)

TASK
Write a full draft for this ONE chapter.

STRUCTURE (required)
- Title line (chapter title)
- 5–8 short sections with headings
- Practical examples (realistic, not made-up corporate case studies)
- A brief "Make it yours" section: 6–10 short prompts for the user to customize (their story, their phrasing, their examples)
- End with exactly 5 reflection questions (bullets)

STYLE RULES (strict)
- Sound like the user's sample (if provided)
- Plain language, strong clarity
- No fluff: avoid “unlock,” “transform,” “game-changer,” “in today’s world,” etc.
- No repeating the same idea in different words
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.65,
      messages: [
        { role: "system", content: system },
        { role: "system", content: voiceBlock },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    });

    const content = resp?.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // If the model ever breaks format, we still return something usable
      parsed = { expanded: content };
    }

    const expanded = clean(parsed.expanded);
    if (!expanded) {
      return res.status(500).json({ error: "No expanded text returned" });
    }

    return res.status(200).json({ expanded });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
