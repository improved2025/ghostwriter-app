// account.js
// Shared auth + session helpers for all pages.
// Requires: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

const SUPABASE_URL = "https://siiivusryuotqmbcerqp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpaWl2dXNyeXVvdHFtYmNlcnFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY0ODc4NjIsImV4cCI6MjA4MjA2Mzg2Mn0.Sgx9Qy0t-8w6M2BeFyWRR3lCHcZkj_cLioJAq5XlNKc";

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

    async function requireUserId() {
      const { data, error } = await client.auth.getUser();
      if (error) throw error;
      const user = data?.user;
      if (!user?.id) throw new Error("No authenticated user");
      return user.id;
    }

    function activeProjectKey(userId) {
      return `authored_active_project_id_${userId}`;
    }

    // Helper: get current user (null if none)
    async function currentUser() {
      const { data } = await client.auth.getUser();
      return data?.user || null;
    }

    // Expose ONE object that every page can use.
    window.AuthoredAccount = {
      client,

      async signIn(email, password) {
        return await client.auth.signInWithPassword({ email, password });
      },

      async signUp(email, password) {
        // Note: if email confirmations are ON in Supabase, this may require confirmation.
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

      // --------------------------------------------
      // Anonymous auth (guest) + auto-convert support
      // --------------------------------------------
      async signInGuest() {
        // If there is already a session, keep it.
        const { data: s } = await client.auth.getSession();
        if (s?.session?.user) return { data: s, error: null };

        // Create an anonymous session
        // Requires Supabase: Auth -> Providers -> Anonymous enabled
        const { data, error } = await client.auth.signInAnonymously();
        return { data, error };
      },

      async convertGuestToEmailPassword(email, password) {
        // Converts the CURRENT user (must be anonymous) into an email/password user
        // Keeps the same user_id and preserves guest usage rows keyed by user_id
        const u = await currentUser();
        if (!u) return { data: null, error: new Error("No session to convert") };
        if (!u.is_anonymous) {
          return { data: { user: u }, error: null }; // already real user
        }

        // Update the anon user with email/password
        // Depending on your Supabase settings, this may send a confirmation email.
        const { data, error } = await client.auth.updateUser({
          email,
          password
        });

        return { data, error };
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
      },

      // -----------------------------
      // Projects helper (per-book)
      // -----------------------------
      projects: {
        async getActiveProjectId() {
          const userId = await requireUserId();
          return localStorage.getItem(activeProjectKey(userId)) || "";
        },

        async setActiveProjectId(projectId) {
          const userId = await requireUserId();
          localStorage.setItem(activeProjectKey(userId), projectId);
        },

        async clearActiveProjectId() {
          const userId = await requireUserId();
          localStorage.removeItem(activeProjectKey(userId));
        },

        async getProject(projectId) {
          const userId = await requireUserId();
          const { data, error } = await client
            .from("projects")
            .select("*")
            .eq("id", projectId)
            .eq("user_id", userId)
            .maybeSingle();
          if (error) throw error;
          return data || null;
        },

        async createProject(payload) {
          const userId = await requireUserId();
          const insertRow = {
            user_id: userId,
            topic: payload.topic,
            audience: payload.audience || null,
            blocker: payload.blocker || null,
            chapters: payload.chapters || 12,
            voice_sample: payload.voiceSample || null,
            voice_notes: payload.voiceNotes || null
          };

          const { data, error } = await client
            .from("projects")
            .insert(insertRow)
            .select("*")
            .single();

          if (error) throw error;
          await this.setActiveProjectId(data.id);
          return data;
        },

        async updateProject(projectId, updates) {
          const userId = await requireUserId();
          const safe = { ...updates };
          delete safe.user_id;
          delete safe.id;

          const { data, error } = await client
            .from("projects")
            .update(safe)
            .eq("id", projectId)
            .eq("user_id", userId)
            .select("*")
            .single();

          if (error) throw error;
          return data;
        },

        // Create an active project if none exists.
        // If one exists, reuse it and update the "project definition" fields.
        async getOrCreateActiveProject(payload) {
          const userId = await requireUserId();
          const existingId = localStorage.getItem(activeProjectKey(userId)) || "";

          if (existingId) {
            const existing = await this.getProject(existingId);
            if (existing) {
              return await this.updateProject(existing.id, {
                topic: payload.topic,
                audience: payload.audience || null,
                blocker: payload.blocker || null,
                chapters: payload.chapters || 12,
                voice_sample: payload.voiceSample || null,
                voice_notes: payload.voiceNotes || null
              });
            }
          }

          return await this.createProject(payload);
        }
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
