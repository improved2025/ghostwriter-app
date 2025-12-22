export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const { topic, audience, blocker } = req.body || {};

    const clean = (v) => (v || "").toString().trim();
    const t = clean(topic) || "your message";
    const a = clean(audience) || "the people you want to reach";
    const b = clean(blocker) || "self-doubt";

    const prompt = `
You are a helpful book coach. Create:
1) A working title (short)
2) A one-sentence purpose statement
3) A 5-chapter outline with chapter titles only

Make it clear, human, and encouraging. No hype. No mention of AI.

Topic: ${t}
Audience: ${a}
Blocker: ${b}

Return JSON ONLY in this format:
{
  "title": "...",
  "purpose": "...",
  "outline": ["...", "...", "...", "...", "..."]
}
`.trim();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: "OpenAI error", details: text });
    }

    const data = await response.json();
    const text =
      data.output?.[0]?.content?.[0]?.text ||
      data.output_text ||
      "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: "Model returned invalid JSON", raw: text });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
