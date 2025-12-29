import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

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

    // Strict, non-robotic, voice-matching system rules
    const system = `
You are Authored: a book-coach and writing partner.
You do NOT write "for" the user. You write WITH the user.
You must match the user's voice and writing patterns when a writing sample is provided.
You must never sound generic, corporate, robotic, or like a template.

OUTPUT RULE:
Return ONLY valid JSON (no markdown, no commentary). Use EXACT schema:
{
  "title": "string",
  "purpose": "string",
  "outline": [
    { "chapter": 1, "title": "string", "bullets": ["string","string","string"] }
  ]
}

CONTENT RULES:
- outline length MUST equal requested chapter count
- chapter numbers start at 1 and are sequential
- bullets: 3 to 5 items each
- Keep chapter titles specific and non-generic (avoid "Introduction to...", "Overview of...")
- Bullets must be actionable and concrete (avoid fluff: "explore", "delve", "unlock", "journey")
- Never mention OpenAI, ChatGPT, "as an AI", "I can't", or policies
- Avoid repeating the user's input verbatim; transform it into a useful plan
`.trim();

    // Voice constraints (very strict). If no sample, still force natural human tone.
    const voiceBlock = `
VOICE REQUIREMENTS (STRICT):
- If a writing sample exists: mirror its sentence length, rhythm, vocabulary level, and punctuation habits.
- Keep the user's natural phrases and cadence.
- Do not add preachy/academic/corporate tone unless the sample clearly is.
- No filler. No hype. No buzzwords.
- Prefer clear, direct sentences.
- When uncertain, choose simpler wording over fancy wording.

Voice Notes (user preferences):
${voiceNotes || "(none)"}

User Writing Sample:
${voiceSample ? `"""${voiceSample}"""` : "(none provided)"}
`.trim();

    const user = `
Topic: ${topic}
Audience: ${audience || "general readers"}
Main blocker: ${blocker || "none"}
Chapters requested: ${chapters}

TASK:
Create:
1) A working title the user would actually choose
2) A one-sentence purpose (plain, specific)
3) A chapter outline with ${chapters} chapters

Each chapter object MUST include:
- chapter number
- title
- 3–5 bullets (practical subtopics or steps)

IMPORTANT:
The outline must feel like it came from the same person as the writing sample (if provided).
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.55,
      messages: [
        { role: "system", content: system },
        { role: "system", content: voiceBlock },
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

    // Hard validation
    if (!data || typeof data !== "object") throw new Error("Bad JSON object");
    if (!Array.isArray(data.outline)) throw new Error("Missing outline array");

    // Fix count
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
