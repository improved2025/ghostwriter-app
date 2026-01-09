// /api/outline.js
// Outline generation (UNLIMITED) with strict JSON output + strong error visibility

import OpenAI from "openai";

function clean(v) {
  return (v ?? "").toString().trim();
}

function json(res, status, payload) {
  res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Use POST" });

  // ---- ENV sanity ----
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(res, 500, {
      error: "Missing OPENAI_API_KEY",
      hint:
        "Vercel → Project → Settings → Environment Variables → add OPENAI_API_KEY (all environments) → Redeploy",
    });
  }

  try {
    const body = req.body || {};

    const topic = clean(body.topic);
    const audience = clean(body.audience) || "general readers";
    const blocker = clean(body.blocker) || "none";
    const chaptersRaw = parseInt(body.chapters, 10);
    const chapters = Number.isFinite(chaptersRaw) ? chaptersRaw : 12;

    const voiceSample = clean(body.voiceSample);
    const voiceNotes = clean(body.voiceNotes);

    if (!topic) return json(res, 400, { error: "Missing topic" });
    if (chapters < 3 || chapters > 30) {
      return json(res, 400, { error: "Invalid chapters (must be 3–30)" });
    }

    const voiceBlock = voiceSample
      ? `VOICE SAMPLE (match tone and phrasing STRICTLY; do not sound robotic):
${voiceSample}

VOICE NOTES:
${voiceNotes || "none"}`
      : `VOICE NOTES:
${voiceNotes || "none"} (Keep voice natural and human.)`;

    const system = `
You are a professional book coach.
You are writing WITH the author, not for them.
Return ONLY valid JSON (no markdown, no commentary).

Schema (EXACT):
{
  "title": "string",
  "purpose": "string",
  "outline": [
    { "chapter": 1, "title": "string", "bullets": ["string","string","string"] }
  ]
}

Rules:
- outline.length MUST equal chapters requested
- chapters start at 1 and are sequential
- bullets: 3 to 5 per chapter
- Practical, clear, non-robotic
- Respect the author voice sample/notes
`.trim();

    const user = `
Topic: ${topic}
Audience: ${audience}
Main blocker: ${blocker}
Chapters requested: ${chapters}

${voiceBlock}

Create a clear starter outline that helps the user write.
`.trim();

    const openai = new OpenAI({ apiKey });

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });

    const raw = resp?.choices?.[0]?.message?.content || "";
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json(res, 500, {
        error: "OpenAI returned invalid JSON",
        raw_preview: raw.slice(0, 800),
      });
    }

    // ---- Normalize + harden output ----
    const title = clean(data.title) || topic;
    const purpose = clean(data.purpose) || `A practical guide about ${topic}.`;

    let outline = Array.isArray(data.outline) ? data.outline : [];
    // Force correct length
    if (outline.length !== chapters) {
      outline = outline.slice(0, chapters);
      while (outline.length < chapters) {
        const n = outline.length + 1;
        outline.push({
          chapter: n,
          title: `Chapter ${n}`,
          bullets: ["Key idea", "Example", "Action step"],
        });
      }
    }

    outline = outline.map((c, i) => ({
      chapter: Number.isFinite(Number(c.chapter)) ? Number(c.chapter) : i + 1,
      title: clean(c.title) || `Chapter ${i + 1}`,
      bullets:
        Array.isArray(c.bullets) && c.bullets.length
          ? c.bullets.map(clean).filter(Boolean).slice(0, 5)
          : ["Key idea", "Example", "Action step"],
    }));

    return json(res, 200, { title, purpose, outline });
  } catch (err) {
    // IMPORTANT: return a clear server error payload
    return json(res, 500, {
      error: "Outline generation failed",
      details: clean(err?.message || err),
      // safe booleans only (helps debug env issues without leaking secrets)
      env: {
        hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      },
    });
  }
}
