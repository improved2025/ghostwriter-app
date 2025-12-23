<script>
  // 1) Paste your Supabase values here (ONLY here)
  const SUPABASE_URL = "https://siiivusryuotqmbcerqp.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc";

  // 2) Load Supabase client from CDN
  // If this fails, AuthoredAccount will not work.
</script>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

<script>
  // 3) Create the client
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // 4) Expose a simple API your pages can call
  window.AuthoredAccount = {
    async signUp(email, password) {
      return await supabase.auth.signUp({ email, password });
    },
    async signIn(email, password) {
      return await supabase.auth.signInWithPassword({ email, password });
    },
    async signOut() {
      return await supabase.auth.signOut();
    },
    async getUser() {
      return await supabase.auth.getUser();
    }
  };
</script>
