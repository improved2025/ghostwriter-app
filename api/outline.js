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

    const topic = clean(body.topic);
    const audience = clean(body.audience) || "general readers";
    const blocker = clean(body.blocker) || "none";
    const chapters = Number.isFinite(parseInt(body.chapters, 10)) ? parseInt(body.chapters, 10) : 12;

    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    // Optional: pass userId from client when logged in
    const userId = clean(body.userId) || null;

    if (!topic) return res.status(400).json({ error: "Missing topic" });

    const system = `
You are a professional book coach and ghostwriter.
Return ONLY valid JSON (no markdown, no commentary).
Schema:
{
  "title": "string",
  "purpose": "string",
  "outline": [
    { "chapter": 1, "title": "string", "bullets": ["string","string","string"] }
  ]
}
Rules:
- outline length MUST equal chapters requested
- chapters start at 1, sequential
- bullets: 3 to 5 per chapter
- keep the outline practical and specific
`.trim();

    const voiceBlock = voiceSample
      ? `VOICE SAMPLE (copy the tone, cadence, phrasing, and level of formality; do NOT sound generic):
${voiceSample}

VOICE NOTES:
${voiceNotes || "none"}`
      : `VOICE NOTES:
${voiceNotes || "none"} (If no sample provided, keep the voice natural, human, non-robotic.)`;

    const user = `
Topic: ${topic}
Audience: ${audience}
Main blocker: ${blocker}
Chapters requested: ${chapters}

${voiceBlock}

Create a clear, practical book outline that helps the user write (not just a finished product).
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const content = resp?.choices?.[0]?.message?.content || "";
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      return res.status(500).json({
        error: "OpenAI returned non-JSON.",
        raw: content.slice(0, 2000),
      });
    }

    if (!data || typeof data !== "object") throw new Error("Bad JSON object");
    if (!Array.isArray(data.outline)) throw new Error("Missing outline array");

    // Force correct count
    if (data.outline.length !== chapters) {
      data.outline = data.outline.slice(0, chapters);
      while (data.outline.length < chapters) {
        const n = data.outline.length + 1;
        data.outline.push({
          chapter: n,
          title: `Chapter ${n}`,
          bullets: ["Key idea", "Example", "Action step"],
        });
      }
    }

    // Normalize
    data.title = clean(data.title) || topic;
    data.purpose = clean(data.purpose) || `A practical guide on ${topic}.`;
    data.outline = data.outline.map((c, i) => ({
      chapter: Number.isFinite(c.chapter) ? c.chapter : i + 1,
      title: clean(c.title) || `Chapter ${i + 1}`,
      bullets: Array.isArray(c.bullets) && c.bullets.length
        ? c.bullets.map(clean).filter(Boolean).slice(0, 5)
        : ["Key idea", "Example", "Action step"],
    }));

    // Create project row
    const insertPayload = {
      user_id: userId || null,
      chapters,
      is_paid: false,
      updated_at: new Date().toISOString(),
    };

    const { data: proj, error: projErr } = await supabase
      .from("projects")
      .insert(insertPayload)
      .select("id")
      .single();

    if (projErr) {
      return res.status(500).json({
        error: "could not create project row in supabase",
        details: projErr,
      });
    }

    return res.status(200).json({
      projectId: proj.id,
      title: data.title,
      purpose: data.purpose,
      outline: data.outline,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
