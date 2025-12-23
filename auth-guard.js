// auth-guard.js
(async function () {
  // Wait for account.js to initialize
  const start = Date.now();
  while (!window.AuthoredAccount) {
    if (window.AuthoredAccountInitError) {
      console.error("Auth init error:", window.AuthoredAccountInitError);
      break;
    }
    if (Date.now() - start > 6000) break;
    await new Promise(r => setTimeout(r, 50));
  }

  try {
    if (!window.AuthoredAccount) {
      // If auth didn’t initialize, treat as not logged in
      window.location.href = "./login.html";
      return;
    }

    const user = await window.AuthoredAccount.getUser();
    // getUser() returns { data: { user } } in our wrapper
    const actualUser = user?.data?.user || user; // handles either shape safely

    if (!actualUser) {
      // Not logged in → go to login
      window.location.href = "./login.html";
      return;
    }

    // Logged in → do nothing, let start.html load normally
  } catch (e) {
    console.error("Auth guard failed:", e);
    window.location.href = "./login.html";
  }
})();
