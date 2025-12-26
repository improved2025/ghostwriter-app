// account.js — single source of truth for Supabase client

const SUPABASE_URL = "https://siiivusryuotqmbcerqp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc";

if (!window.supabase) {
  console.error("Supabase CDN not loaded. Make sure supabase-js <script> is above account.js in the HTML.");
}

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage
  }
});

// Optional: quick visibility while debugging
window.supabaseClient.auth.getSession().then(({ data }) => {
  console.log("Supabase session on load:", data.session);
});
