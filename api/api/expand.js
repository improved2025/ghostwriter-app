export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

    const {
      bookTitle = "Untitled",
      purpose = "",
      chapterNumber = 1,
      chapterTitle = "Chapter",
      audience = "",
      topic = ""
    } = req.body || {};

    const prompt = `
You are a helpful writing coach. Expand ONE chapter draft.

Rules:
- Clear, human, and practical.
- No hype. No mention of AI.
- Keep it readable and structured.
- Length: 700 to 1200 words.

Book title: ${bookTitle}
Purpose: ${purpose}
Topic: ${topic}
Audience: ${audience}

Write Chapter ${chapterNumber}: ${chapterTitle}

Return JSON ONLY in this format:
{
  "expanded": "..."
}
`.trim();

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You write clear, human chapter drafts." },
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      })
    });

    const raw = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        error: "OpenAI request failed",
        details: raw
      });
    }

    const content = raw?.choices?.[0]?.message?.content || "";

    // Try to parse JSON from the model response
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // fallback: wrap plain text
      parsed = { expanded: content };
    }

    return res.status(200).json({
      expanded: parsed.expanded || ""
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
