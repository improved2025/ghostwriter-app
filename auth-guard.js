// auth-guard.js
(async function () {
  try {
    const page = (location.pathname.split("/").pop() || "").toLowerCase();

    // Public pages allowed without session
    const PUBLIC_PAGES = new Set(["login.html", "signup.html", "index.html"]);

    // Wait briefly for Supabase to load
    const start = Date.now();
    while (!window.supabase && Date.now() - start < 4000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // If Supabase still isn't available, fail closed only for protected pages
    if (!window.supabase) {
      if (!PUBLIC_PAGES.has(page)) location.href = "./login.html";
      return;
    }

    // Read current session
    const { data, error } = await window.supabase.auth.getSession();
    if (error) {
      if (!PUBLIC_PAGES.has(page)) location.href = "./login.html";
      return;
    }

    const session = data?.session;

    // If not logged in and page is protected -> go to login
    if (!session && !PUBLIC_PAGES.has(page)) {
      location.href = "./login.html";
      return;
    }

    // If logged in and user is on login/signup -> send to start
    if (session && (page === "login.html" || page === "signup.html")) {
      location.href = "./start.html";
      return;
    }

    // Otherwise do nothing
  } catch {
    // If anything fails, only force login on protected pages
    const page = (location.pathname.split("/").pop() || "").toLowerCase();
    const PUBLIC_PAGES = new Set(["login.html", "signup.html", "index.html"]);
    if (!PUBLIC_PAGES.has(page)) location.href = "./login.html";
  }
})();
