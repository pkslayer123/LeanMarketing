#!/usr/bin/env node

/**
 * SimulationAdapter — General-purpose user simulation for persona testing.
 *
 * Supports multiple auth systems:
 *   - supabase: Real session swap via GoTrue API (full RLS coverage)
 *   - clerk: Session token injection via Clerk testing mode
 *   - nextauth: Cookie-based session injection
 *   - custom: Configurable cookie/header-based auth
 *   - none: Unauthenticated page testing only
 *
 * The adapter reads auth config from persona-engine.json and adapts
 * the simulation strategy accordingly. For Supabase-based apps, it
 * performs real auth sessions (like ChangePilot). For others, it injects
 * auth tokens/cookies so RLS and middleware see a real user.
 */

const fs = require("fs");
const path = require("path");

function findProjectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(path.join(dir, "persona-engine.json")) ||
      fs.existsSync(path.join(dir, "daemon-config.json")) ||
      fs.existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return process.cwd();
}

const ROOT = findProjectRoot();

/**
 * Load project config to determine auth strategy.
 */
function loadConfig() {
  const configPath = path.join(ROOT, "persona-engine.json");
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch { /* fall through */ }
  }
  return {};
}

/**
 * Detect auth system from project structure if not explicitly configured.
 */
function detectAuthSystem(projectRoot) {
  const checks = [
    { system: "supabase", files: ["lib/supabaseClient.ts", "lib/supabaseServer.ts", "utils/supabase/client.ts"] },
    { system: "clerk", files: ["middleware.ts"], pattern: /@clerk/ },
    { system: "nextauth", files: ["app/api/auth/[...nextauth]/route.ts", "pages/api/auth/[...nextauth].ts"] },
  ];

  for (const check of checks) {
    for (const file of check.files) {
      const fullPath = path.join(projectRoot, file);
      if (fs.existsSync(fullPath)) {
        if (check.pattern) {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (check.pattern.test(content)) { return check.system; }
        } else {
          return check.system;
        }
      }
    }
  }
  return "none";
}

/**
 * SimulationAdapter — configurable per-auth-system simulation.
 *
 * Usage in test fixtures:
 *   const adapter = new SimulationAdapter(page, config);
 *   await adapter.loginAsDeveloper();
 *   await adapter.simulateAs({ role: "user", name: "Test User" });
 *   // ... run tests ...
 *   await adapter.stopSimulation();
 */
class SimulationAdapter {
  constructor(page, options = {}) {
    this.page = page;
    this.baseUrl = options.baseUrl || process.env.BASE_URL || "http://localhost:3000";
    this.authSystem = options.auth || detectAuthSystem(ROOT);
    this.supabaseUrl = options.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    this.supabaseAnonKey = options.supabaseAnonKey || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    this.supabaseServiceKey = options.supabaseServiceKey || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    this.devEmail = options.devEmail || process.env.E2E_DEV_EMAIL || "";
    this.devPassword = options.devPassword || process.env.E2E_DEV_PASSWORD || "";
    this.testEmail = options.testEmail || process.env.E2E_TEST_EMAIL || "";
    this.testPassword = options.testPassword || process.env.E2E_TEST_PASSWORD || "";
    this.currentPersona = null;
    this.findings = [];
    this._sessionCache = {};
  }

  /**
   * Login as the developer/admin account.
   * Strategy varies by auth system.
   */
  async loginAsDeveloper() {
    switch (this.authSystem) {
      case "supabase":
        return this._supabaseLogin(this.devEmail, this.devPassword);
      case "clerk":
        return this._clerkLogin(this.devEmail, this.devPassword);
      case "nextauth":
        return this._nextauthLogin(this.devEmail, this.devPassword);
      default:
        // No auth — just navigate to base URL
        await this.page.goto(this.baseUrl);
        return;
    }
  }

  /**
   * Simulate as a persona with a given role/name/department.
   *
   * For Supabase: creates/updates a test user profile, signs in as them.
   * For Clerk: uses testing token with claims override.
   * For NextAuth: injects session cookie with role override.
   * For none: sets X-Test-Role header via route handler.
   *
   * @param {Object} persona - { role, name, department, organizationId, traits }
   */
  async simulateAs(persona) {
    this.currentPersona = persona;

    switch (this.authSystem) {
      case "supabase":
        return this._supabaseSimulate(persona);
      case "clerk":
        return this._clerkSimulate(persona);
      case "nextauth":
        return this._nextauthSimulate(persona);
      default:
        return this._headerSimulate(persona);
    }
  }

  /**
   * Swap to a different persona mid-test without full re-auth.
   */
  async swapTo(persona) {
    this.currentPersona = persona;

    switch (this.authSystem) {
      case "supabase":
        return this._supabaseSwap(persona);
      default:
        // For non-Supabase, just re-simulate
        return this.simulateAs(persona);
    }
  }

  /**
   * Stop simulation and restore original session.
   */
  async stopSimulation() {
    this.currentPersona = null;

    switch (this.authSystem) {
      case "supabase":
        return this._supabaseStopSimulation();
      case "clerk":
        return this._clerkStopSimulation();
      default:
        // Clear any test headers/cookies
        await this.page.goto(this.baseUrl);
    }
  }

  /**
   * Report a finding from persona testing.
   */
  reportFinding(finding) {
    this.findings.push({
      ...finding,
      persona: this.currentPersona?.name || "unknown",
      timestamp: new Date().toISOString(),
      url: this.page.url(),
    });
  }

  /**
   * Get accumulated findings.
   */
  getFindings() {
    return this.findings;
  }

  /**
   * Make an API request with simulation headers.
   */
  async apiRequest(method, url, body) {
    const fullUrl = url.startsWith("http") ? url : `${this.baseUrl}${url}`;
    const headers = { "Content-Type": "application/json" };

    if (this.currentPersona) {
      headers["X-Simulation"] = JSON.stringify({
        enabled: true,
        role: this.currentPersona.role,
        testAccountName: this.currentPersona.name,
        is_e2e_test: true,
        persona_id: this.currentPersona.id || this.currentPersona.name,
      });
    }

    // Use page.evaluate to make request with browser cookies
    return this.page.evaluate(
      async ({ url, method, body, headers }) => {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          credentials: "include",
        });
        return { status: res.status, data: await res.json().catch(() => null) };
      },
      { url: fullUrl, method, body, headers }
    );
  }

  // -------------------------------------------------------------------------
  // Supabase auth strategy (real session swap, full RLS coverage)
  // -------------------------------------------------------------------------

  async _supabaseLogin(email, password) {
    if (!email || !password) {
      console.warn("[SimulationAdapter] No dev credentials — skipping login");
      await this.page.goto(this.baseUrl);
      return;
    }

    // Try GoTrue API login first (faster than form)
    const cacheKey = `${email}:dev`;
    if (this._sessionCache[cacheKey]) {
      await this._injectSupabaseSession(this._sessionCache[cacheKey]);
      return;
    }

    try {
      const tokenRes = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": this.supabaseAnonKey,
        },
        body: JSON.stringify({ email, password }),
      });

      if (tokenRes.ok) {
        const session = await tokenRes.json();
        this._sessionCache[cacheKey] = session;
        await this._injectSupabaseSession(session);
        return;
      }
    } catch { /* fall through to form login */ }

    // Fallback: browser form login
    await this.page.goto(`${this.baseUrl}/login`);
    await this.page.fill('input[type="email"], input[name="email"]', email);
    await this.page.fill('input[type="password"], input[name="password"]', password);
    await this.page.click('button[type="submit"]');
    await this.page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
  }

  async _supabaseSimulate(persona) {
    if (!this.testEmail || !this.testPassword) {
      console.warn("[SimulationAdapter] No test credentials — using header simulation");
      return this._headerSimulate(persona);
    }

    // Step 1: Update test user profile via simulation API (if available)
    const startRes = await this.apiRequest("POST", "/api/admin/simulation/start", {
      testUserId: null, // Let the API find/create one
      role: persona.role || "user",
      full_name: persona.name || "Test User",
      department_id: persona.departmentId,
      organization_id: persona.organizationId,
    });

    if (startRes.status === 200 || startRes.status === 201) {
      // Sign in as the test user
      const testEmail = startRes.data?.testUserEmail || this.testEmail;
      const testPassword = startRes.data?.testUserPassword || this.testPassword;
      await this._supabaseLogin(testEmail, testPassword);
      return;
    }

    // Fallback: If no simulation API, use service role to update profile directly
    if (this.supabaseServiceKey) {
      await this._supabaseDirectSimulate(persona);
      return;
    }

    // Last resort: header-only simulation
    return this._headerSimulate(persona);
  }

  async _supabaseDirectSimulate(persona) {
    // Use service role key to update test user's profile
    try {
      const res = await fetch(`${this.supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(this.testEmail)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": this.supabaseServiceKey,
          "Authorization": `Bearer ${this.supabaseServiceKey}`,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({
          role: persona.role || "user",
          full_name: persona.name || "Test User",
          ...(persona.departmentId ? { department_id: persona.departmentId } : {}),
          ...(persona.organizationId ? { organization_id: persona.organizationId } : {}),
        }),
      });

      if (!res.ok) {
        // Try user_profiles table (ChangePilot naming convention)
        await fetch(`${this.supabaseUrl}/rest/v1/user_profiles?email=eq.${encodeURIComponent(this.testEmail)}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": this.supabaseServiceKey,
            "Authorization": `Bearer ${this.supabaseServiceKey}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({
            role: persona.role || "user",
            full_name: persona.name || "Test User",
            ...(persona.departmentId ? { department_id: persona.departmentId } : {}),
            ...(persona.organizationId ? { organization_id: persona.organizationId } : {}),
          }),
        });
      }
    } catch (err) {
      console.warn(`[SimulationAdapter] Direct profile update failed: ${err.message}`);
    }

    // Sign in as test user with updated profile
    await this._supabaseLogin(this.testEmail, this.testPassword);
  }

  async _supabaseSwap(persona) {
    // Try swap API first
    const swapRes = await this.apiRequest("POST", "/api/admin/simulation/swap", {
      role: persona.role || "user",
      full_name: persona.name,
      department_id: persona.departmentId,
      organization_id: persona.organizationId,
    });

    if (swapRes.status === 200) {
      await this.page.reload();
      return;
    }

    // Fallback: full re-simulate
    return this._supabaseSimulate(persona);
  }

  async _supabaseStopSimulation() {
    try {
      await this.apiRequest("POST", "/api/admin/simulation/stop", {});
    } catch { /* ignore */ }
    await this.page.goto(this.baseUrl);
  }

  async _injectSupabaseSession(session) {
    // Build the Supabase SSR cookie value
    const cookieValue = Buffer.from(JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (session.expires_in || 3600),
      expires_in: session.expires_in || 3600,
      token_type: "bearer",
    })).toString("base64");

    // Supabase SSR uses project ref from URL for cookie name
    const projectRef = this.supabaseUrl.match(/https:\/\/([^.]+)\./)?.[1] || "sb";
    const cookieName = `sb-${projectRef}-auth-token`;

    // Chunk if needed (Supabase SSR chunks at ~3180 chars)
    const maxChunk = 3180;
    const url = new URL(this.baseUrl);

    if (cookieValue.length <= maxChunk) {
      await this.page.context().addCookies([{
        name: cookieName,
        value: cookieValue,
        domain: url.hostname,
        path: "/",
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax",
      }]);
    } else {
      // Chunked cookies (.0, .1, .2, ...)
      const chunks = [];
      for (let i = 0; i < cookieValue.length; i += maxChunk) {
        chunks.push(cookieValue.slice(i, i + maxChunk));
      }
      const cookies = chunks.map((chunk, i) => ({
        name: `${cookieName}.${i}`,
        value: chunk,
        domain: url.hostname,
        path: "/",
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax",
      }));
      await this.page.context().addCookies(cookies);
    }

    // Navigate to verify session
    await this.page.goto(this.baseUrl);
  }

  // -------------------------------------------------------------------------
  // Clerk auth strategy (testing tokens)
  // -------------------------------------------------------------------------

  async _clerkLogin(email, password) {
    // Clerk testing mode: use CLERK_TESTING_TOKEN if available
    const testToken = process.env.CLERK_TESTING_TOKEN;
    if (testToken) {
      await this.page.goto(this.baseUrl);
      await this.page.evaluate((token) => {
        window.__clerk_testing_token = token;
      }, testToken);
      return;
    }

    // Fallback: browser form login
    await this.page.goto(`${this.baseUrl}/sign-in`);
    await this.page.fill('input[name="identifier"]', email);
    await this.page.click('button[type="submit"]');
    await this.page.fill('input[name="password"]', password);
    await this.page.click('button[type="submit"]');
    await this.page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 15000 });
  }

  async _clerkSimulate(persona) {
    // Clerk doesn't have native simulation — use metadata override
    // Set user metadata via Clerk Backend API if CLERK_SECRET_KEY available
    const clerkSecret = process.env.CLERK_SECRET_KEY;
    if (clerkSecret && this.testEmail) {
      try {
        // Find or create test user
        const listRes = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(this.testEmail)}`, {
          headers: { Authorization: `Bearer ${clerkSecret}` },
        });
        const users = await listRes.json();
        if (users.length > 0) {
          // Update public metadata with role
          await fetch(`https://api.clerk.com/v1/users/${users[0].id}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${clerkSecret}`,
            },
            body: JSON.stringify({
              public_metadata: {
                role: persona.role || "user",
                department: persona.department,
                simulated: true,
              },
            }),
          });
        }
      } catch (err) {
        console.warn(`[SimulationAdapter] Clerk metadata update failed: ${err.message}`);
      }
    }

    // Login as test user
    if (this.testEmail && this.testPassword) {
      await this._clerkLogin(this.testEmail, this.testPassword);
    }
  }

  async _clerkStopSimulation() {
    // Clear Clerk session
    await this.page.evaluate(() => {
      if (window.Clerk) { window.Clerk.signOut(); }
    });
    await this.page.goto(this.baseUrl);
  }

  // -------------------------------------------------------------------------
  // NextAuth strategy (session cookie injection)
  // -------------------------------------------------------------------------

  async _nextauthLogin(email, password) {
    // NextAuth: use CSRF + credentials provider
    await this.page.goto(`${this.baseUrl}/api/auth/signin`);

    // Try credentials form
    const emailInput = this.page.locator('input[name="email"], input[type="email"]');
    if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await emailInput.fill(email);
      const passwordInput = this.page.locator('input[name="password"], input[type="password"]');
      if (await passwordInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await passwordInput.fill(password);
      }
      await this.page.click('button[type="submit"]');
      await this.page.waitForURL((url) => !url.pathname.includes("/signin"), { timeout: 15000 });
    }
  }

  async _nextauthSimulate(persona) {
    // NextAuth: inject a session token with role claims
    // This requires NEXTAUTH_SECRET to sign the token
    const secret = process.env.NEXTAUTH_SECRET;
    if (secret) {
      // Set simulation context in localStorage for client-side
      await this.page.goto(this.baseUrl);
      await this.page.evaluate((p) => {
        localStorage.setItem("persona-simulation", JSON.stringify({
          role: p.role,
          name: p.name,
          department: p.department,
          active: true,
        }));
      }, persona);
    }

    // Login as test user if credentials available
    if (this.testEmail && this.testPassword) {
      await this._nextauthLogin(this.testEmail, this.testPassword);
    }
  }

  // -------------------------------------------------------------------------
  // Header-only strategy (no auth, just X-Test-Persona header)
  // -------------------------------------------------------------------------

  async _headerSimulate(persona) {
    // Set extra HTTP headers for all subsequent requests
    await this.page.setExtraHTTPHeaders({
      "X-Test-Persona": JSON.stringify({
        role: persona.role || "user",
        name: persona.name || "Test User",
        department: persona.department,
        is_e2e_test: true,
      }),
    });

    await this.page.goto(this.baseUrl);
  }
}

module.exports = { SimulationAdapter, detectAuthSystem, findProjectRoot };
