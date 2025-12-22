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
    const action = body.action || "outline";

    // Helper
    const clean = (v) => (v ?? "").toString().trim();

    if (action === "expand") {
      const bookTitle = clean(body.bookTitle) || "Untitled";
      const purpose = clean(body.purpose) || "";
      const chapterNumber = Number(body.chapterNumber || 1);
      const chapterTitle = clean(body.chapterTitle) || `Chapter ${chapterNumber}`;
      const audience = clean(body.audience) || "";
      const topic = clean(body.topic) || "";

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
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You write clear, human chapter drafts." },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
        }),
      });

      const raw = await r.json();

      if (!r.ok) {
        return res.status(r.status).json({
          error: "OpenAI request failed",
          details: raw,
        });
      }

      const content = raw?.choices?.[0]?.message?.content || "";
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = { expanded: content };
      }

      return res.status(200).json({ expanded: parsed.expanded || "" });
    }

    // Default action = outline
    const topic = clean(body.topic) || "your message";
    const audience = clean(body.audience) || "the people you want to reach";
    const blocker = clean(body.blocker) || "self-doubt";
    const chapters = Number(body.chapters || 5);

    const prompt = `
You are a helpful book coach. Create:
1) A working title (short)
2) A one-sentence purpose statement
3) A ${chapters}-chapter outline with chapter titles only

Make it clear, human, and encouraging. No hype. No mention of AI.

Topic: ${topic}
Audience: ${audience}
Blocker: ${blocker}

Return JSON ONLY in this format:
{
  "title": "...",
  "purpose": "...",
  "outline": ["...", "...", "..."]
}
`.trim();

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const raw = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        error: "OpenAI request failed",
        details: raw,
      });
    }

    const content = raw?.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(500).json({
        error: "Model did not return JSON",
        details: { content },
      });
    }

    return res.status(200).json({
      title: parsed.title || "",
      purpose: parsed.purpose || "",
      outline: Array.isArray(parsed.outline) ? parsed.outline : [],
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}
