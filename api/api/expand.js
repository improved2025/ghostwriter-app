export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

    const body = req.body || {};
    const bookTitle = (body.bookTitle || "").toString().trim();
    const purpose = (body.purpose || "").toString().trim();
    const chapterTitle = (body.chapterTitle || "").toString().trim();

    if (!chapterTitle) {
      return res.status(400).json({ error: "Missing chapterTitle" });
    }

    const prompt = `
You are a helpful book coach.
Write an expanded draft for ONE chapter.

Book title: ${bookTitle || "Untitled"}
Purpose: ${purpose || "N/A"}
Chapter: ${chapterTitle}

Rules:
- Write in a clear, human voice.
- No hype. No mention of AI.
- Give a practical chapter draft with headings.
- 900 to 1300 words.
- End with 5 bullet-point reflection questions.
Return JSON only in this format:
{
  "expanded": "..."
}
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful book coach." },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: "OpenAI request failed",
        details: data,
      });
    }

    const text = data?.choices?.[0]?.message?.content || "";

    // try to parse JSON; if model returns text, wrap it
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { expanded: text };
    }

    return res.status(200).json({
      expanded: parsed.expanded || text,
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
