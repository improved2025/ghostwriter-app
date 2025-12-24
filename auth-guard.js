// auth-guard.js
(async function () {
  try {
    // If Supabase library didn't load, fail closed (redirect)
    if (!window.supabase || !window.AuthoredAccount || !window.AuthoredAccount.supabase) {
      window.location.href = "./login.html";
      return;
    }

    const supa = window.AuthoredAccount.supabase;

    const { data, error } = await supa.auth.getSession();
    if (error) {
      window.location.href = "./login.html";
      return;
    }

    const session = data?.session;
    if (!session) {
      window.location.href = "./login.html";
      return;
    }

    // If session exists, allow page
  } catch (e) {
    window.location.href = "./login.html";
  }
})();
