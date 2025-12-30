import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });

    const body = req.body || {};
    const clean = (v) => (v ?? "").toString().trim();

    const topic = clean(body.topic);
    const audience = clean(body.audience);
    const blocker = clean(body.blocker);
    const chapters = Number.isFinite(parseInt(body.chapters, 10)) ? parseInt(body.chapters, 10) : 12;

    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    // Must have topic
    if (!topic) return res.status(400).json({ error: "Missing topic" });

    // Get user from Supabase auth (token sent automatically by supabase-js on frontend)
    // We accept userId from client for now to keep it simple.
    const userId = clean(body.userId);

    const openai = new OpenAI({ apiKey });

    const system = `
You are a professional ghostwriter.
Return ONLY valid JSON (no markdown, no commentary).
JSON schema:
{
  "title": "string",
  "purpose": "string",
  "outline": [
    { "chapter": 1, "title": "string", "bullets": ["string","string","string"] }
  ]
}
Rules:
- outline length must equal requested chapters
- chapter numbers start at 1 and are sequential
- bullets: 3 to 5 items each
`.trim();

    const user = `
Topic: ${topic}
Audience: ${audience || "general readers"}
Main blocker: ${blocker || "none"}
Chapters requested: ${chapters}

Voice sample:
${voiceSample || "none"}

Voice notes:
${voiceNotes || "none"}

Create a clear, practical book outline.
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

    const content = resp?.choices?.[0]?.message?.content || "";
    let data;

    try {
      data = JSON.parse(content);
    } catch {
      return res.status(500).json({
        error: "OpenAI returned non-JSON.",
        raw: content.slice(0, 1200)
      });
    }

    // Normalize + validate
    if (!data || typeof data !== "object" || !Array.isArray(data.outline)) {
      return res.status(500).json({ error: "Bad outline format returned" });
    }

    if (data.outline.length !== chapters) {
      data.outline = data.outline.slice(0, chapters);
      while (data.outline.length < chapters) {
        const n = data.outline.length + 1;
        data.outline.push({ chapter: n, title: `Chapter ${n}`, bullets: ["Key idea", "Example", "Action step"] });
      }
    }

    data.title = clean(data.title) || topic;
    data.purpose = clean(data.purpose) || `A practical guide on ${topic}.`;

    data.outline = data.outline.map((c, i) => ({
      chapter: Number.isFinite(c.chapter) ? c.chapter : i + 1,
      title: clean(c.title) || `Chapter ${i + 1}`,
      bullets: Array.isArray(c.bullets) ? c.bullets.map(clean).filter(Boolean).slice(0, 5) : ["Key idea", "Example", "Action step"]
    }));

    // ✅ Create a project row and return the ID
    const insert = await supabase
      .from("projects")
      .insert([{
        user_id: userId || null,
        title: data.title,
        topic,
        audience,
        blocker,
        outline: data.outline,
        purpose: data.purpose,
        plan: "free"
      }])
      .select("id")
      .single();

    if (insert.error || !insert.data?.id) {
      return res.status(500).json({ error: "Could not create project row in Supabase" });
    }

    return res.status(200).json({
      ...data,
      projectId: insert.data.id
    });

  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
