// account.js
(function () {
  const SUPABASE_URL = "https://siiivusryuotqmbcerqp.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc";

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    SUPABASE_URL.includes("PASTE_") ||
    SUPABASE_ANON_KEY.includes("PASTE_")
  ) {
    console.error("AuthoredAccount: Missing Supabase URL or anon key in account.js");
    window.AuthoredAccount = null;
    return;
  }

  // Supabase UMD must be loaded in the HTML first (window.supabase exists)
  const client = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  if (!client) {
    console.error("AuthoredAccount: Supabase library not loaded (window.supabase missing).");
    window.AuthoredAccount = null;
    return;
  }

  window.AuthoredAccount = {
    client,

    async signUp(email, password) {
      return client.auth.signUp({ email, password });
    },

    async signIn(email, password) {
      return client.auth.signInWithPassword({ email, password });
    },

    async signOut() {
      return client.auth.signOut();
    },

    async getUser() {
      const { data } = await client.auth.getUser();
      return data?.user || null;
    }
  };
})();
