// account.js (NO modules, works in plain HTML)

(function () {
  // IMPORTANT:
  // Paste your Supabase Project URL and Anon Key below (from Supabase settings).
  const SUPABASE_URL = https://siiivusryuotqmbcerqp.supabase.co;
  const SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc;

  if (!window.supabase) {
    console.error("Supabase SDK not loaded. Check the CDN script tag.");
    return;
  }

  const { createClient } = window.supabase;
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  window.AuthoredAccount = {
    signUp: async (email, password) => {
      return await client.auth.signUp({ email, password });
    },
    signIn: async (email, password) => {
      return await client.auth.signInWithPassword({ email, password });
    },
    signOut: async () => {
      return await client.auth.signOut();
    },
    getUser: async () => {
      return await client.auth.getUser();
    },
  };
})();
