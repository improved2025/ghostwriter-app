// account.js
// Shared auth + session helpers for all pages.
// Requires: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

const SUPABASE_URL = "https://siiivusryuotqmbcerqp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc";

(function initAuthoredAccount() {
  try {
    if (!SUPABASE_URL || SUPABASE_URL.includes("PASTE_")) {
      throw new Error("Missing SUPABASE_URL in account.js");
    }
    if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("PASTE_")) {
      throw new Error("Missing SUPABASE_ANON_KEY in account.js");
    }
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error("Supabase JS not loaded. Include supabase-js@2 script before account.js");
    }

    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Expose ONE object that every page can use.
    window.AuthoredAccount = {
      client,

      async signIn(email, password) {
        return await client.auth.signInWithPassword({ email, password });
      },

      async signUp(email, password) {
        return await client.auth.signUp({ email, password });
      },

      async signOut() {
        return await client.auth.signOut();
      },

      async getSession() {
        return await client.auth.getSession();
      },

      async getUser() {
        return await client.auth.getUser();
      },

      // For protected pages: redirect to login if not authenticated
      async requireUser(redirectTo = "login.html") {
        const { data, error } = await client.auth.getSession();
        if (error) throw error;

        const session = data?.session;
        if (!session) {
          window.location.href = redirectTo;
          return null;
        }
        return session.user;
      }
    };

    // Helpful debug (optional)
    client.auth.getSession().then(({ data }) => {
      console.log("Supabase session on load:", data?.session || null);
    });

  } catch (err) {
    console.error("Auth init failed:", err);
    window.AuthoredAccountInitError = String(err?.message || err);
  }
})();
