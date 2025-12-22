export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const { topic, audience, blocker, chapters } = req.body || {};

    const clean = (v) => (v || "").toString().trim();
    const t = clean(topic) || "your message";
    const a = clean(audience) || "the people you want to reach";
    const b = clean(blocker) || "self-doubt";

    let n = parseInt(chapters, 10);
    if (![5, 8, 10, 12].includes(n)) n = 5;

    const prompt = `
You are a helpful book coach.

Create:
1) A working title (short)
2) A one-sentence purpose statement
3) A ${n}-chapter outline with chapter titles only

Make it clear, human, and encouraging. No hype. No mention of AI.

Topic: ${t}
Audience: ${a}
Blocker: ${b}

Return JSON ONLY in this format:
{
  "title": "...",
  "purpose": "...",
  "outline": ["...", "..."]
}
`.trim();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

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

    const raw = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: "OpenAI request failed", details: raw });
    }

    // The model returns JSON in message.content (we parse it safely)
    const content = raw?.choices?.[0]?.message?.content || "";
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      return res.status(500).json({ error: "Model did not return valid JSON", details: content });
    }

    // Basic cleanup
    const title = clean(data.title) || "Untitled";
    const purpose = clean(data.purpose) || "";
    const outlineArr = Array.isArray(data.outline) ? data.outline.map(clean).filter(Boolean) : [];

    return res.status(200).json({
      title,
      purpose,
      outline: outlineArr.slice(0, n),
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}

