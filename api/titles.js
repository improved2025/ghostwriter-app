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
    const voiceSample = clean(body.voiceSample); // optional

    if (!topic) return res.status(400).json({ error: "Missing topic" });

    const system = `
You generate book title options in the user's voice.
Return ONLY valid JSON: {"titles":["..."]}.
No markdown. No commentary.
`.trim();

    const user = `
Give 12 strong book title options.

Topic: ${topic}
Audience: ${audience || "general readers"}
Writing blocker: ${blocker || "none"}

VOICE RULES (STRICT):
- If a user sample is provided, mirror its tone and style.
- If not, write natural, human, and not robotic.
- Avoid generic titles like "The Ultimate Guide".

User writing sample (if any):
${voiceSample ? voiceSample : "(none)"}

Return JSON only: {"titles":["..."]}.
`.trim();

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.8,
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

    const titles = Array.isArray(data.titles) ? data.titles.map(clean).filter(Boolean) : [];
    if (!titles.length) return res.status(500).json({ error: "No titles returned" });

    return res.status(200).json({ titles: titles.slice(0, 12) });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
