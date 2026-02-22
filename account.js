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

    // IMPORTANT:
    // Expose a stable global for auth-guard.js (and any other script).
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

    function isAnonymousUser(user) {
      return !!user?.is_anonymous;
    }

    function isEmailVerified(user) {
      // Supabase user has email_confirmed_at when verified
      return !!user?.email_confirmed_at;
    }

    function defaultEmailRedirectTo() {
      // Where the confirmation link should land after the user clicks it
      // Keep this simple and stable:
      return `${window.location.origin}/login.html`;
    }

    async function currentUser() {
      const { data } = await client.auth.getUser();
      return data?.user || null;
    }

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

    function shouldAutoCreateGuestIdentity() {
      // This is the key fix:
      // Do NOT create anonymous sessions on auth pages. It causes confusion and redirects.
      const path = (window.location.pathname || "").toLowerCase();
      const file = path.split("/").pop() || "";

      // Add/remove files here if needed:
      const block = new Set(["login.html", "signup.html", "verify.html"]);
      if (block.has(file)) return false;

      // Allow manual override on any page:
      // <script>window.AUTHORED_DISABLE_AUTO_GUEST = true</script> (before loading account.js)
      if (window.AUTHORED_DISABLE_AUTO_GUEST === true) return false;

      return true;
    }

    // Auto-create a stable identity for visitors (guest sessions)
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

    // Run once on load
    client.auth.getSession().then(({ data }) => {
      writeAuthCookies(data?.session || null);

      // Only auto-create guest identity on non-auth pages
      if (shouldAutoCreateGuestIdentity()) {
        ensureIdentity().catch(() => {});
      }

      // console.log("Supabase session on load:", data?.session || null);
    });

    window.AuthoredAccount = {
      client,

      // ===== Identity =====
      async ensureIdentity() {
        return await ensureIdentity();
      },

      // ===== Auth =====
      async signIn(email, password) {
        // Cookies update via onAuthStateChange
        return await client.auth.signInWithPassword({ email, password });
      },

      async signUp(email, password, options = {}) {
        // Force confirmation link to come back to your site
        const emailRedirectTo =
          options.emailRedirectTo || defaultEmailRedirectTo();

        return await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo }
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
      async convertGuestToEmailPassword(email, password, options = {}) {
        const u = await currentUser();
        if (!u) return { data: null, error: new Error("No session to convert") };
        if (!u.is_anonymous) return { data: { user: u }, error: null };

        const emailRedirectTo =
          options.emailRedirectTo || defaultEmailRedirectTo();

        const { data, error } = await client.auth.updateUser(
          { email, password },
          { emailRedirectTo }
        );
        return { data, error };
      },

      // ===== Verification helpers (use these in start.html or guards) =====
      isAnonymousUser(user) {
        return isAnonymousUser(user);
      },

      isEmailVerified(user) {
        return isEmailVerified(user);
      },

      // Requires a REAL user (not anonymous). Redirects if missing.
      async requireRealUser(redirectTo = "login.html") {
        const { data, error } = await client.auth.getSession();
        if (error) throw error;

        const session = data?.session;
        const user = session?.user || null;

        if (!session || !user || isAnonymousUser(user)) {
          window.location.href = redirectTo;
          return null;
        }
        return user;
      },

      // Requires REAL + VERIFIED user. Use this to protect start.html.
      async requireVerifiedUser(
        redirectToLogin = "login.html",
        redirectToVerify = "verify.html"
      ) {
        const user = await this.requireRealUser(redirectToLogin);
        if (!user) return null;

        if (!isEmailVerified(user)) {
          window.location.href = redirectToVerify;
          return null;
        }
        return user;
      },

      // For protected pages: redirect to login if no session (includes anonymous sessions)
      // NOTE: this is unchanged behavior; use requireRealUser/requireVerifiedUser for stricter gating.
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

      // ===== Projects (unchanged) =====
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
  } catch (err) {
    console.error("Auth init failed:", err);
    window.AuthoredAccountInitError = String(err?.message || err);
  }
})();
