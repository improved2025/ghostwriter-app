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
    const topic = clean(body.topic);
    const audience = clean(body.audience);
    const voiceSample = clean(body.voiceSample); // optional: user pasted sample writing

    if (!bookTitle && !topic) return res.status(400).json({ error: "Missing bookTitle/topic" });

    const system = `
You are a book coach helping the USER write in THEIR voice.
You are not writing for them. You are writing with them.
Return ONLY valid JSON: {"introduction":"..."}.
Do not include markdown.
`.trim();

    const user = `
Write a strong book introduction.

Inputs:
- Book title: ${bookTitle || "(use best title from topic)"}
- Topic: ${topic || "(not provided)"}
- Audience: ${audience || "general readers"}
- Purpose: ${purpose || "(not provided)"}

VOICE RULES (STRICT):
- Mirror the user's tone, rhythm, and word choice if a sample is provided.
- If no sample is provided, write warm, clear, human, and non-robotic.
- Avoid generic filler. Avoid hype. Avoid "as an AI".
- Sound like a real person teaching and guiding.

User writing sample (if any):
${voiceSample ? voiceSample : "(none)"}

Length:
- 700 to 1100 words
Structure:
- Hook
- Why this matters
- What the reader will get
- Who this is for
- How to use the book
- A short personal-sounding close
Return JSON only.
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      response_format: { type: "json_object" }
    });

    const content = resp?.choices?.[0]?.message?.content || "{}";
    let data;
    try { data = JSON.parse(content); }
    catch {
      return res.status(500).json({ error: "OpenAI returned non-JSON", raw: content.slice(0, 2000) });
    }

    const intro = clean(data.introduction);
    if (!intro) return res.status(500).json({ error: "No introduction returned" });

    return res.status(200).json({ introduction: intro });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
