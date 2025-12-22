export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { title, purpose, outline, audience, topic } = req.body || {};

    const clean = (v) => (v || "").toString().trim();
    const bookTitle = clean(title) || "Untitled";
    const bookPurpose = clean(purpose) || "";
    const aud = clean(audience) || "the intended reader";
    const top = clean(topic) || "the book topic";

    const outlineArr = Array.isArray(outline) ? outline.map(clean).filter(Boolean) : [];
    if (outlineArr.length === 0) return res.status(400).json({ error: "Missing outline" });

    const prompt = `
You are a practical book coach.

Given this book:
Title: ${bookTitle}
Purpose: ${bookPurpose}
Topic: ${top}
Audience: ${aud}

Expand the outline by adding:
- a one-sentence summary for each chapter
- 4–6 key points per chapter (bullets)

Do NOT rewrite the chapter titles.
No hype. No mention of AI.

Return JSON ONLY in this format:
{
  "expandedOutline": [
    { "chapterTitle": "...", "summary": "...", "keyPoints": ["...", "..."] }
  ]
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
          { role: "system", content: "You are a practical book coach." },
          { role: "user", content: prompt + "\n\nOutline:\n" + outlineArr.map((x,i)=>`${i+1}. ${x}`).join("\n") },
        ],
        temperature: 0.6,
      }),
    });

    const raw = await response.json();
    if (!response.ok) return res.status(500).json({ error: "OpenAI request failed", details: raw });

    const content = raw?.choices?.[0]?.message?.content || "";
    let data;
    try { data = JSON.parse(content); }
    catch { return res.status(500).json({ error: "Model did not return valid JSON", details: content }); }

    const expanded = Array.isArray(data.expandedOutline) ? data.expandedOutline : [];
    return res.status(200).json({ expandedOutline: expanded });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
}
