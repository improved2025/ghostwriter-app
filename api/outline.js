import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });

    const openai = new OpenAI({ apiKey });

    const body = req.body || {};
    const clean = (v) => (v ?? "").toString().trim();

    const topic = clean(body.topic);
    const audience = clean(body.audience);
    const blocker = clean(body.blocker);
    const chapters = Number.isFinite(parseInt(body.chapters, 10)) ? parseInt(body.chapters, 10) : 12;

    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    if (!topic) return res.status(400).json({ error: "Missing topic" });

    const system = `
You are Authored, a writing partner.
NON-NEGOTIABLE: You do NOT write for the user. You write WITH the user in the user's voice.

STRICT VOICE ENFORCEMENT
1) If a voice sample is provided, you MUST imitate its tone, rhythm, sentence length tendency, vocabulary choices, and emotional temperature.
2) You MUST NOT sound like an assistant, consultant, or generic AI writing.
3) You MUST NOT use filler openers or hype phrases like:
   "In today’s world", "Let’s dive in", "Unlock", "Transform", "This guide will", "In this chapter", "Journey", "Game-changer".
4) You MUST match the user’s writing level (simple vs advanced). Do not over-polish.
5) You MUST NOT copy sentences from the sample. Mimic style only.

OUTPUT RULES (STRICT)
Return ONLY valid JSON (no markdown, no commentary, no extra keys).
Schema must be EXACTLY:
{
  "title": "string",
  "purpose": "string",
  "outline": [
    { "chapter": 1, "title": "string", "bullets": ["string", "string", "string"] }
  ]
}

CONTENT RULES
- outline length MUST equal requested chapter count
- chapter numbers start at 1 and increment by 1
- bullets: 3 to 5 per chapter
- bullets must be specific ideas or actions (no vague fluff)
- the title must sound like something the user would actually choose
- purpose must be ONE sentence, concrete, and in the user’s voice

FINAL SELF-CHECK (INTERNAL)
Before returning JSON, verify:
- It matches the sample’s voice (if provided)
- No banned phrases appear
- No lines are copied from the sample
If any check fails, rewrite before returning JSON.
`.trim();

    const user = `
TOPIC: ${topic}
AUDIENCE: ${audience || "general readers"}
BLOCKER: ${blocker || "none"}
CHAPTERS: ${chapters}

VOICE NOTES:
${voiceNotes || "none"}

VOICE SAMPLE:
${voiceSample || "none"}

Task:
Create a title, a one-sentence purpose, and an outline that matches the user's voice.
Write it the way the user would naturally speak to their audience.
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.55,
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

    if (!data || typeof data !== "object") throw new Error("Bad JSON object");
    if (!Array.isArray(data.outline)) throw new Error("Missing outline array");

    // Ensure chapters count matches
    if (data.outline.length !== chapters) {
      data.outline = data.outline.slice(0, chapters);
      while (data.outline.length < chapters) {
        const n = data.outline.length + 1;
        data.outline.push({
          chapter: n,
          title: `Chapter ${n}`,
          bullets: ["Key idea", "Example", "Action step"]
        });
      }
    }

    // Normalize
    data.title = clean(data.title) || topic;
    data.purpose = clean(data.purpose) || `A practical guide on ${topic}.`;
    data.outline = data.outline.map((c, i) => ({
      chapter: Number.isFinite(c.chapter) ? c.chapter : i + 1,
      title: clean(c.title) || `Chapter ${i + 1}`,
      bullets:
        Array.isArray(c.bullets) && c.bullets.length
          ? c.bullets.map(clean).filter(Boolean).slice(0, 5)
          : ["Key idea", "Example", "Action step"]
    }));

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
