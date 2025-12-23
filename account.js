// account.js
// One single Supabase client for the whole app.
// You only change these TWO lines.

const SUPABASE_URL = "https://siiivusryuotqmbcerqp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc";

// Load Supabase from CDN (v2). If it's already loaded, reuse it.
(function initSupabase() {
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.defer = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function start() {
    if (!SUPABASE_URL || SUPABASE_URL.includes("PASTE_")) {
      throw new Error("Missing SUPABASE_URL in account.js");
    }
    if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("PASTE_")) {
      throw new Error("Missing SUPABASE_ANON_KEY in account.js");
    }

    // Load supabase-js if not present
    if (!window.supabase) {
      await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    }

    // Create ONE client and store it globally
    window.supabaseClient = window.supabaseClient || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Expose simple helpers
    window.AuthoredAccount = {
      async signUp(email, password) {
        return await window.supabaseClient.auth.signUp({ email, password });
      },

      async signIn(email, password) {
        return await window.supabaseClient.auth.signInWithPassword({ email, password });
      },

      async signOut() {
        return await window.supabaseClient.auth.signOut();
      },

      async getUser() {
        return await window.supabaseClient.auth.getUser();
      }
    };
  }

  start().catch((e) => {
    console.error("AuthoredAccount init failed:", e);
    // Keep a clear flag for pages to show an error
    window.AuthoredAccountInitError = e?.message || String(e);
  });
})();
