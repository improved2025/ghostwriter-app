import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    // 1. Get API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "Missing OPENAI_API_KEY in Vercel env vars" });
    }

    // 2. Create OpenAI client
    const openai = new OpenAI({
      apiKey,
    });

    // 3. Read request body
    const body = req.body || {};
    const topic = (body.topic || "Untitled book").toString();
    const chapters = Number(body.chapters || 10);

    // 4. Call OpenAI (simple + reliable)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a professional book outlining assistant. Respond clearly.",
        },
        {
          role: "user",
          content: `Create a ${chapters}-chapter book outline for a book titled: "${topic}". 
Include a short purpose statement and numbered chapter titles.`,
        },
      ],
    });

    const text = completion.choices[0].message.content;

    // 5. Return result
    return res.status(200).json({
      title: topic,
      purpose: "AI-generated book outline",
      outline: text,
    });
  } catch (err) {
    console.error("Outline API error:", err);
    return res.status(500).json({
      error: "Outline generation failed",
      details: err.message,
    });
  }
}
