// api/docx.js
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";

function cleanName(name = "authored.docx") {
  const base = String(name).trim() || "authored.docx";
  const safe = base.replace(/[^\w\s.-]/g, "").replace(/\s+/g, "_");
  return safe.toLowerCase().endsWith(".docx") ? safe : `${safe}.docx`;
}

function splitLines(text = "") {
  return String(text).replace(/\r\n/g, "\n").split("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const body = req.body || {};
    const filename = cleanName(body.filename || "authored.docx");
    const title = (body.title || "").toString().trim();
    const content = (body.content || "").toString();

    if (!content.trim()) {
      return res.status(400).json({ error: "Missing content" });
    }

    // Build simple paragraphs
    const paragraphs = [];

    if (title) {
      paragraphs.push(
        new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 })
      );
      paragraphs.push(new Paragraph({ text: "" }));
    }

    const lines = splitLines(content);
    for (const line of lines) {
      // Preserve blank lines
      if (!line.trim()) {
        paragraphs.push(new Paragraph({ text: "" }));
        continue;
      }

      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: line })],
        })
      );
    }

    const doc = new Document({
      sections: [{ properties: {}, children: paragraphs }],
    });

    const buffer = await Packer.toBuffer(doc);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "DOCX error" });
  }
}
