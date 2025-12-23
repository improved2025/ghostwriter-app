// account.js
// Supabase connection + auth helpers

const SUPABASE_URL = https://siiivusryuotqmbcerqp.supabase.co;
const SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc;

const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

// ---------- AUTH ----------
async function signUp(email, password) {
  return supabase.auth.signUp({ email, password });
}

async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

async function signOut() {
  return supabase.auth.signOut();
}

async function getUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user || null;
}

// ---------- USAGE ----------
async function ensureUsageRow(userId) {
  await supabase
    .from("usage")
    .upsert({ user_id: userId }, { onConflict: "user_id" });
}

async function getUsage(userId) {
  const { data, error } = await supabase
    .from("usage")
    .select("expands_used, plan")
    .eq("user_id", userId)
    .single();

  if (error) throw error;
  return data;
}

async function incrementUsage(userId) {
  const usage = await getUsage(userId);
  const next = (usage.expands_used || 0) + 1;

  const { error } = await supabase
    .from("usage")
    .update({ expands_used: next })
    .eq("user_id", userId);

  if (error) throw error;
  return next;
}

// Make functions available everywhere
window.AuthoredAccount = {
  signUp,
  signIn,
  signOut,
  getUser,
  ensureUsageRow,
  getUsage,
  incrementUsage
};
