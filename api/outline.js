import OpenAI from "openai";

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

    const body = req.body || {};
    const clean = (v) => (v ?? "").toString().trim();

    const topic = clean(body.topic);
    const audience = clean(body.audience) || "general readers";
    const blocker = clean(body.blocker) || "none";
    const chapters = Number(body.chapters) || 12;

    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    if (!topic) {
      return res.status(400).json({ error: "Missing topic" });
    }

    const system = `
You are a professional book coach.
Return ONLY valid JSON. No markdown. No commentary.

Schema:
{
  "title": "string",
  "purpose": "string",
  "outline": [
    { "chapter": 1, "title": "string", "bullets": ["string","string","string"] }
  ]
}

Rules:
- Outline length must equal chapters requested
- Chapters start at 1 and are sequential
- Bullets: 3–5 per chapter
- Practical, human, non-robotic
`.trim();

    const voiceBlock = voiceSample
      ? `VOICE SAMPLE (match tone and phrasing strictly):
${voiceSample}

VOICE NOTES:
${voiceNotes || "none"}`
      : `VOICE NOTES:
${voiceNotes || "none"} (Keep voice natural and human.)`;

    const user = `
Topic: ${topic}
Audience: ${audience}
Main blocker: ${blocker}
Chapters requested: ${chapters}

${voiceBlock}

Create a clear starter outline that helps the user write.
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    });

    const content = resp.choices?.[0]?.message?.content || "";
    const data = JSON.parse(content);

    return res.status(200).json({
      title: data.title,
      purpose: data.purpose,
      outline: data.outline
    });

  } catch (err) {
    return res.status(500).json({
      error: "Outline generation failed",
      details: err.message
    });
  }
}
