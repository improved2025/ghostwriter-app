const { data: { session } } = await client.auth.getSession();

if (!session) {
  window.location.replace("login.html");
  return;
}

// Treat anonymous as NOT authenticated
const provider = session.user?.app_metadata?.provider;
const isAnon =
  session.user?.is_anonymous === true ||
  provider === "anonymous" ||
  !session.user?.email;

if (isAnon) {
  window.location.replace("login.html");
  return;
}
