(async function () {
  const page = location.pathname.split("/").pop();

  // Never guard login/signup pages
  if (page === "login.html" || page === "signup.html" || page === "") return;

  // Wait briefly for account.js (defer) to load
  const start = Date.now();
  while (!window.AuthoredAccount?.client) {
    if (window.AuthoredAccountInitError) break;
    if (Date.now() - start > 8000) break;
    await new Promise(r => setTimeout(r, 50));
  }

  const client = window.AuthoredAccount?.client;
  if (!client) {
    // Fail closed: if auth system isn't ready, force login
    window.location.replace("login.html");
    return;
  }

  const { data: { session } } = await client.auth.getSession();

  if (!session) {
    window.location.replace("login.html");
    return;
  }

  // Optional: treat anonymous as not-logged-in (useful if you enabled anon auth)
  const userEmail = session.user?.email || "";
  if (!userEmail) {
    window.location.replace("login.html");
    return;
  }
})();
