export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const { email, title, purpose, outline, source } = req.body || {};

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "invalid_email" });
    }
    if (!Array.isArray(outline) || outline.length < 1) {
      return res.status(400).json({ error: "missing_outline" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "server_not_configured" });
    }

    // Save lead to Supabase (always do this first)
    const insertPayload = {
      email: email.trim().toLowerCase(),
      source: (source || "guest_outline").toString(),
      title: (title || "").toString().slice(0, 200),
      purpose: (purpose || "").toString().slice(0, 2000),
      outline, // json array
      user_agent: (req.headers["user-agent"] || "").toString().slice(0, 300),
      ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().slice(0, 80),
    };

    const supaResp = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(insertPayload),
    });

    if (!supaResp.ok) {
      const txt = await supaResp.text().catch(() => "");
      return res.status(500).json({ error: "lead_save_failed", details: txt.slice(0, 300) });
    }

    // OPTIONAL: send email (non-fatal)
    // If you don't configure RESEND_API_KEY / FROM_EMAIL, we just return saved:true
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const FROM_EMAIL = process.env.FROM_EMAIL; // e.g. "Authored <support@myauthored.com>"
    const APP_URL = process.env.APP_URL || ""; // e.g. https://myauthored.com

    let emailed = false;

    if (RESEND_API_KEY && FROM_EMAIL) {
      const subject = "Your Authored outline is saved";

      const outlineLines = outline
        .map((x, i) => {
          const t = typeof x === "string" ? x : (x?.title || `Chapter ${i + 1}`);
          return `${i + 1}. ${String(t)}`;
        })
        .join("\n");

      const returnLink = APP_URL ? `${APP_URL.replace(/\/$/, "")}/start.html` : "start.html";

      const textBody =
`You started something important.

Here’s the outline you created with Authored. Save this email so you can come back to it anytime.

Title: ${title || "Untitled"}

Purpose:
${purpose || ""}

Outline:
${outlineLines}

Continue writing here:
${returnLink}

— Authored`;

      const resendResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: email,
          subject,
          text: textBody,
        }),
      });

      emailed = resendResp.ok;
    }

    return res.status(200).json({ ok: true, saved: true, emailed });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
}
