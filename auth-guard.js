(async function () {
  const page = location.pathname.split("/").pop();

  // Never guard login/signup pages
  if (page === "login.html" || page === "signup.html" || page === "" ) return;

  const client = window.supabaseClient;
  if (!client) {
    console.error("supabaseClient not found. account.js may not be loading.");
    return;
  }

  const { data: { session } } = await client.auth.getSession();

  if (!session) {
    window.location.replace("login.html");
  }
})();
