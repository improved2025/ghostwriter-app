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

    // NEW: voice capture (optional)
    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    if (!topic) {
      return res.status(400).json({ error: "Missing topic" });
    }

    // We are not "writing the whole book", we are helping them write.
    // The outline should feel like THEIR thinking + THEIR voice.
    const system = `
You are Authored, a writing partner.
You do NOT write for the user. You write WITH the user.
Your job is to create a clear starting point they can refine.

Return ONLY valid JSON (no markdown, no commentary).
The JSON schema must be EXACTLY:
{
  "title": "string",
  "purpose": "string",
  "outline": [
    { "chapter": 1, "title": "string", "bullets": ["string", "string", "string"] }
  ]
}

Rules:
- outline length must equal the requested chapter count
- chapter numbers must start at 1 and be sequential
- bullets: 3 to 5 items each
- be specific, practical, and non-robotic
- avoid filler phrases and generic clichés
- if a voice sample is provided, match its tone, rhythm, and word choice (without copying lines)
`.trim();

    const user = `
Topic: ${topic}
Audience: ${audience || "general readers"}
Main blocker: ${blocker || "none"}
Chapters requested: ${chapters}

VOICE SAMPLE (if provided, match it):
${voiceSample ? voiceSample : "[No sample provided]"}

VOICE NOTES (if provided, follow them):
${voiceNotes ? voiceNotes : "[No notes provided]"}

Task:
Create a clear book starter package (title, one-sentence purpose, and chapter outline).
This should feel like the user's voice and thinking.
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
    } catch (e) {
      return res.status(500).json({
        error: "OpenAI returned non-JSON. Update prompt or model.",
        raw: content.slice(0, 2000)
      });
    }

    // Hard validation so the UI ALWAYS gets what it expects
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
