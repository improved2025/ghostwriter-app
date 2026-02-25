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

    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true
      }
    });

    // Stable global for other scripts
    window.supabaseClient = client;

    function setCookie(name, value, maxAgeSeconds) {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      const maxAge = typeof maxAgeSeconds === "number" ? `; Max-Age=${maxAgeSeconds}` : "";
      document.cookie = `${name}=${encodeURIComponent(value || "")}; Path=/; SameSite=Lax${maxAge}${secure}`;
    }

    function clearCookie(name) {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${name}=; Path=/; SameSite=Lax; Max-Age=0${secure}`;
    }

    function writeAuthCookies(session) {
      if (!session?.access_token) {
        clearCookie("sb-access-token");
        clearCookie("sb-refresh-token");
        return;
      }

      const oneWeek = 60 * 60 * 24 * 7;
      setCookie("sb-access-token", session.access_token, oneWeek);
      setCookie("sb-refresh-token", session.refresh_token || "", oneWeek);
    }

    // ---- AUTH HELPERS ----
    function isRealUser(user) {
      return !!user && user.is_anonymous === false;
    }

    function isEmailConfirmed(user) {
      // Supabase sets email_confirmed_at when verified
      return !!user?.email_confirmed_at;
    }

    function isLaunchReadyUser(user) {
      return isRealUser(user) && isEmailConfirmed(user);
    }

    async function currentUser() {
      const { data } = await client.auth.getUser();
      return data?.user || null;
    }

    async function requireLaunchReadyUser(redirectTo) {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;

      const user = data?.session?.user || null;

      if (!user) {
        if (redirectTo) window.location.replace(redirectTo);
        throw new Error("Not signed in");
      }

      if (!isRealUser(user)) {
        if (redirectTo) window.location.replace(redirectTo);
        throw new Error("Guest session not allowed here");
      }

      if (!isEmailConfirmed(user)) {
        if (redirectTo) window.location.replace(redirectTo);
        throw new Error("Email not confirmed");
      }

      return user;
    }

    async function requireLaunchReadyUserId() {
      const user = await requireLaunchReadyUser();
      if (!user?.id) throw new Error("No authenticated user");
      return user.id;
    }

    function activeProjectKey(userId) {
      return `authored_active_project_id_${userId}`;
    }

    // Guest identity is still useful (limits, guest mode),
    // but PROJECTS will be blocked unless the user is launch-ready.
    async function ensureIdentity() {
      const { data } = await client.auth.getSession();
      if (data?.session) {
        writeAuthCookies(data.session);
        return data.session;
      }

      // Requires: Supabase Auth -> Providers -> Anonymous enabled
      const { data: anonData, error } = await client.auth.signInAnonymously();
      if (error) {
        console.warn("Anonymous sign-in failed:", error.message || error);
        return null;
      }

      writeAuthCookies(anonData?.session || null);
      return anonData?.session || null;
    }

    // Keep cookies synced any time auth changes
    client.auth.onAuthStateChange((_event, session) => {
      writeAuthCookies(session || null);
    });

    // Run once on load: keep cookies in sync + create guest identity (safe)
    client.auth.getSession().then(({ data }) => {
      writeAuthCookies(data?.session || null);
      ensureIdentity().catch(() => {});
    });

    window.AuthoredAccount = {
      client,

      // Expose checks
      isRealUser,
      isEmailConfirmed,
      isLaunchReadyUser,

      async ensureIdentity() {
        return await ensureIdentity();
      },

      async signIn(email, password) {
        const r = await client.auth.signInWithPassword({ email, password });
        return r;
      },

      // Supports emailRedirectTo
      async signUp(email, password, options = {}) {
        return await client.auth.signUp({
          email,
          password,
          options: options?.emailRedirectTo ? { emailRedirectTo: options.emailRedirectTo } : undefined
        });
      },

      async signOut() {
        const r = await client.auth.signOut();
        clearCookie("sb-access-token");
        clearCookie("sb-refresh-token");
        return r;
      },

      async getSession() {
        return await client.auth.getSession();
      },

      async getUser() {
        return await client.auth.getUser();
      },

      // Converts anon user into email/password user (same user_id)
      // Note: with email confirmation enabled, this may NOT create a session immediately.
      async convertGuestToEmailPassword(email, password, options = {}) {
        const u = await currentUser();
        if (!u) return { data: null, error: new Error("No session to convert") };
        if (!u.is_anonymous) return { data: { user: u }, error: null };

        const payload = { email, password };
        const opt = options?.emailRedirectTo ? { emailRedirectTo: options.emailRedirectTo } : undefined;

        const { data, error } = await client.auth.updateUser(payload, opt);
        return { data, error };
      },

      // For pages that require a confirmed real user (start.html)
      async requireLaunchReadyUser(redirectTo = "login.html") {
        // redirectTo can include query params if you want
        try {
          return await requireLaunchReadyUser(redirectTo);
        } catch {
          return null;
        }
      },

      projects: {
        // Project ops are now LAUNCH-READY ONLY
        async getActiveProjectId() {
          const userId = await requireLaunchReadyUserId();
          return localStorage.getItem(activeProjectKey(userId)) || "";
        },

        async setActiveProjectId(projectId) {
          const userId = await requireLaunchReadyUserId();
          localStorage.setItem(activeProjectKey(userId), projectId);
        },

        async clearActiveProjectId() {
          const userId = await requireLaunchReadyUserId();
          localStorage.removeItem(activeProjectKey(userId));
        },

        async getProject(projectId) {
          const userId = await requireLaunchReadyUserId();
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
          const userId = await requireLaunchReadyUserId();

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
          const userId = await requireLaunchReadyUserId();
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

        async getOrCreateActiveProject(payload) {
          const userId = await requireLaunchReadyUserId();
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
  } catch (err) {
    console.error("Auth init failed:", err);
    window.AuthoredAccountInitError = String(err?.message || err);
  }
})();
