#!/usr/bin/env node

/**
 * Seed Users — General-purpose test user creation for any Supabase project.
 *
 * Creates the minimum accounts needed for persona testing:
 *   1. A developer account (runs simulations, has full access)
 *   2. A test account (impersonated by personas, profile updated per-test)
 *
 * Reads roles from BUILD-SPEC or persona-engine.json — not hardcoded
 * to any specific role system.
 *
 * For non-Supabase projects, creates a mock auth config file.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
 * Parse roles from BUILD-SPEC.md.
 * Looks for a "## Roles" section with a markdown table.
 */
function parseRolesFromSpec(specPath) {
  if (!fs.existsSync(specPath)) { return ["user", "admin"]; }

  const content = fs.readFileSync(specPath, "utf-8");
  const rolesMatch = content.match(/##\s*Roles[\s\S]*?\|[\s\S]*?\|/);

  if (!rolesMatch) { return ["user", "admin"]; }

  // Parse markdown table rows
  const roles = [];
  const lines = rolesMatch[0].split("\n");
  for (const line of lines) {
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2 && !cells[0].startsWith("-") && cells[0].toLowerCase() !== "role") {
      roles.push(cells[0].toLowerCase());
    }
  }

  return roles.length > 0 ? roles : ["user", "admin"];
}

/**
 * Generate a deterministic password for test accounts.
 * Uses the project name + account type as seed.
 */
function generatePassword(projectName, accountType) {
  const hash = crypto.createHash("sha256").update(`${projectName}:${accountType}:persona-engine`).digest("hex");
  return `pe-${hash.slice(0, 24)}`;
}

/**
 * Seed test users into a Supabase project.
 *
 * @param {Object} options
 * @param {string} options.supabaseUrl - Supabase project URL
 * @param {string} options.supabaseServiceKey - Service role key
 * @param {string} options.projectName - Project name (for password generation)
 * @param {string} [options.specPath] - Path to BUILD-SPEC.md
 * @param {string} [options.organizationId] - Org ID to assign users to
 * @returns {Object} - { devAccount, testAccount, roles, poolConfig }
 */
async function seedUsers(options) {
  const {
    supabaseUrl,
    supabaseServiceKey,
    projectName,
    specPath,
    organizationId,
  } = options;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn("[seed-users] No Supabase credentials — creating mock auth config");
    return createMockAuthConfig(projectName);
  }

  // Determine roles from BUILD-SPEC
  const roles = parseRolesFromSpec(specPath || path.join(ROOT, "docs", "BUILD-SPEC.md"));
  const highestRole = roles[roles.length - 1] || "admin";

  console.log(`  Roles detected: ${roles.join(", ")}`);
  console.log(`  Highest role: ${highestRole}`);

  // Generate account credentials
  const devEmail = `dev@${projectName}.test.local`;
  const devPassword = generatePassword(projectName, "dev");
  const testEmail = `test@${projectName}.test.local`;
  const testPassword = generatePassword(projectName, "test");

  // Create dev account via Supabase Admin API
  const devAccount = await createSupabaseUser({
    supabaseUrl,
    supabaseServiceKey,
    email: devEmail,
    password: devPassword,
    role: highestRole,
    fullName: "Persona Engine Dev",
    isTestAccount: false,
    organizationId,
  });

  // Create test account (will be impersonated by personas)
  const testAccount = await createSupabaseUser({
    supabaseUrl,
    supabaseServiceKey,
    email: testEmail,
    password: testPassword,
    role: "user", // Starts as lowest role, simulation changes it
    fullName: "Persona Test User",
    isTestAccount: true,
    organizationId,
  });

  // Write pool config
  const poolConfig = {
    accounts: [
      {
        index: 0,
        dev: { email: devEmail, password: devPassword, userId: devAccount?.id },
        test: { email: testEmail, password: testPassword, userId: testAccount?.id },
      },
    ],
    roles,
    highestRole,
    projectName,
    createdAt: new Date().toISOString(),
  };

  const poolConfigPath = path.join(ROOT, "e2e", "pool-config.json");
  fs.mkdirSync(path.dirname(poolConfigPath), { recursive: true });
  fs.writeFileSync(poolConfigPath, JSON.stringify(poolConfig, null, 2) + "\n");

  // Write .env entries for E2E
  const envEntries = {
    E2E_DEV_EMAIL: devEmail,
    E2E_DEV_PASSWORD: devPassword,
    E2E_TEST_EMAIL: testEmail,
    E2E_TEST_PASSWORD: testPassword,
  };

  return { devAccount, testAccount, roles, poolConfig, envEntries };
}

/**
 * Create a user in Supabase via the Admin API.
 */
async function createSupabaseUser(options) {
  const {
    supabaseUrl,
    supabaseServiceKey,
    email,
    password,
    role,
    fullName,
    isTestAccount,
    organizationId,
  } = options;

  try {
    // Step 1: Create auth user via GoTrue Admin API
    const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": supabaseServiceKey,
        "Authorization": `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true, // Auto-confirm
        user_metadata: {
          full_name: fullName,
          is_test_account: isTestAccount,
        },
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      // User might already exist
      if (err.msg?.includes("already been registered") || err.message?.includes("already been registered")) {
        console.log(`  User ${email} already exists — updating profile`);
        return updateExistingUser(options);
      }
      console.warn(`  Warning: Failed to create ${email}: ${JSON.stringify(err).slice(0, 200)}`);
      return null;
    }

    const user = await createRes.json();
    const userId = user.id;

    // Step 2: Create/update profile row
    // Try both "profiles" and "user_profiles" table names (varies by project)
    await upsertProfile({
      supabaseUrl,
      supabaseServiceKey,
      userId,
      email,
      role,
      fullName,
      isTestAccount,
      organizationId,
    });

    console.log(`  Created ${isTestAccount ? "test" : "dev"} user: ${email} (${role})`);
    return { id: userId, email, role };
  } catch (err) {
    console.warn(`  Warning: User creation failed for ${email}: ${err.message}`);
    return null;
  }
}

/**
 * Update an existing user's profile.
 */
async function updateExistingUser(options) {
  const { supabaseUrl, supabaseServiceKey, email } = options;

  // Find user by email
  try {
    const listRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`,
      {
        headers: {
          "apikey": supabaseServiceKey,
          "Authorization": `Bearer ${supabaseServiceKey}`,
        },
      }
    );

    // The admin API doesn't support email filter directly, so we search via REST
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id`,
      {
        headers: {
          "apikey": supabaseServiceKey,
          "Authorization": `Bearer ${supabaseServiceKey}`,
        },
      }
    );

    let userId = null;
    if (profileRes.ok) {
      const profiles = await profileRes.json();
      if (profiles.length > 0) {
        userId = profiles[0].id;
      }
    }

    // Try user_profiles table
    if (!userId) {
      const upRes = await fetch(
        `${supabaseUrl}/rest/v1/user_profiles?email=eq.${encodeURIComponent(email)}&select=id`,
        {
          headers: {
            "apikey": supabaseServiceKey,
            "Authorization": `Bearer ${supabaseServiceKey}`,
          },
        }
      );
      if (upRes.ok) {
        const ups = await upRes.json();
        if (ups.length > 0) { userId = ups[0].id; }
      }
    }

    if (userId) {
      await upsertProfile({ ...options, userId });
      return { id: userId, email, role: options.role };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Upsert a profile row. Tries both "profiles" and "user_profiles" tables.
 */
async function upsertProfile(options) {
  const { supabaseUrl, supabaseServiceKey, userId, email, role, fullName, isTestAccount, organizationId } = options;

  const profileData = {
    id: userId,
    email,
    role,
    full_name: fullName,
  };

  // Add optional fields only if they have values
  if (organizationId) { profileData.organization_id = organizationId; }
  if (typeof isTestAccount === "boolean") { profileData.is_test_account = isTestAccount; }

  const tables = ["profiles", "user_profiles"];

  for (const table of tables) {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": supabaseServiceKey,
          "Authorization": `Bearer ${supabaseServiceKey}`,
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify(profileData),
      });

      if (res.ok || res.status === 201 || res.status === 409) {
        return true; // Success or already exists
      }
    } catch {
      // Table might not exist — try next
    }
  }

  return false;
}

/**
 * Create mock auth config for non-Supabase projects.
 */
function createMockAuthConfig(projectName) {
  const mockConfig = {
    authSystem: "mock",
    accounts: [
      {
        index: 0,
        dev: { email: `dev@${projectName}.test`, password: "test-dev-password", userId: "mock-dev-001" },
        test: { email: `test@${projectName}.test`, password: "test-user-password", userId: "mock-test-001" },
      },
    ],
    roles: ["user", "admin"],
    highestRole: "admin",
    projectName,
    createdAt: new Date().toISOString(),
    note: "Mock auth config — replace with real credentials when auth is configured",
  };

  const poolConfigPath = path.join(ROOT, "e2e", "pool-config.json");
  fs.mkdirSync(path.dirname(poolConfigPath), { recursive: true });
  fs.writeFileSync(poolConfigPath, JSON.stringify(mockConfig, null, 2) + "\n");

  return {
    devAccount: mockConfig.accounts[0].dev,
    testAccount: mockConfig.accounts[0].test,
    roles: mockConfig.roles,
    poolConfig: mockConfig,
    envEntries: {
      E2E_DEV_EMAIL: mockConfig.accounts[0].dev.email,
      E2E_DEV_PASSWORD: mockConfig.accounts[0].dev.password,
      E2E_TEST_EMAIL: mockConfig.accounts[0].test.email,
      E2E_TEST_PASSWORD: mockConfig.accounts[0].test.password,
    },
  };
}

// CLI mode
if (require.main === module) {
  (async () => {
    try {
      require("dotenv").config({ path: path.join(ROOT, ".env.local") });
    } catch { /* no dotenv */ }

    const projectName = (() => {
      const configPath = path.join(ROOT, "persona-engine.json");
      if (fs.existsSync(configPath)) {
        try { return JSON.parse(fs.readFileSync(configPath, "utf-8")).name; } catch { /* ignore */ }
      }
      return path.basename(ROOT);
    })();

    console.log(`Seeding test users for ${projectName}...`);

    const result = await seedUsers({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      projectName,
    });

    if (result.envEntries) {
      console.log("\nAdd these to .env.local:");
      for (const [key, value] of Object.entries(result.envEntries)) {
        console.log(`  ${key}=${value}`);
      }
    }

    console.log("\nDone.");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seedUsers, parseRolesFromSpec, generatePassword, createMockAuthConfig };
