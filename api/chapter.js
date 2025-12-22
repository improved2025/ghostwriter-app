export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { title, purpose, audience, topic, chapterTitle } = req.body || {};

    const clean = (v) => (v || "").toString().trim();
    const bookTitle = clean(title) || "Untitled";
    const bookPurpose = clean(purpose) || "";
    const aud = clean(audience) || "the reader";
    const top = clean(topic) || "the topic";
    const ch = clean(chapterTitle);

    if (!ch) return res.status(400).json({ error: "Missing chapterTitle" });

    const prompt = `
You are a practical writing coach.

Book title: ${bookTitle}
Purpose: ${bookPurpose}
Topic: ${top}
Audience: ${aud}

Chapter to expand: ${ch}

Return:
- a one-sentence chapter summary
- 6–8 key points (bullets)
- a short sample paragraph (5–8 sentences) in a clear, human tone

No hype. No mention of AI.

Return JSON ONLY in this format:
{
  "chapterTitle": "...",
  "summary": "...",
  "keyPoints": ["...", "..."],
  "sampleText": "..."
}
`.trim();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a practical writing coach." },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
      }),
    });

    const raw = await response.json();
    if (!response.ok) return res.status(500).json({ error: "OpenAI request failed", details: raw });

    const content = raw?.choices?.[0]?.message?.content || "";
    let data;
    try { data = JSON.parse(content); }
    catch { return res.status(500).json({ error: "Model did not return valid JSON", details: content }); }

    return res.status(200).json({
      chapterTitle: clean(data.chapterTitle) || ch,
      summary: clean(data.summary) || "",
      keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints.map(clean).filter(Boolean) : [],
      sampleText: clean(data.sampleText) || ""
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
