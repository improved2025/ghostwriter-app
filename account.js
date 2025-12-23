<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
  const SUPABASE_URL = "https://siivusryuotqmbcerqp.supabase.co";
  const SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc;

  const supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  );

  window.AuthoredAccount = {
    async signUp(email, password) {
      return await supabase.auth.signUp({
        email,
        password
      });
    },

    async signIn(email, password) {
      return await supabase.auth.signInWithPassword({
        email,
        password
      });
    },

    async signOut() {
      return await supabase.auth.signOut();
    },

    async getUser() {
      const { data } = await supabase.auth.getUser();
      return data?.user || null;
    }
  };
</script>
