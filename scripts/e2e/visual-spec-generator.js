#!/usr/bin/env node

/**
 * visual-spec-generator.js -- Automated visual build spec of the entire site
 *
 * Crawls all routes with Playwright, takes screenshots in light + dark mode,
 * sends to gpt-4o vision for structured analysis, and generates:
 *   - docs/visual-spec/VISUAL-SPEC.md (GitHub-reviewable index)
 *   - docs/visual-spec/pages/*.md (per-page spec with embedded screenshots)
 *   - docs/visual-spec/screenshots/*.png (actual screenshot files)
 *   - e2e/state/visual-spec.json (machine-readable for persona context)
 *
 * Resource-smart: caches screenshot hashes, only re-analyzes changed pages.
 * Designed for nightly runs but can be run manually.
 *
 * Usage:
 *   node scripts/e2e/visual-spec-generator.js                  # Full crawl
 *   node scripts/e2e/visual-spec-generator.js --dry-run        # List routes only
 *   node scripts/e2e/visual-spec-generator.js --routes /mocs   # Single route
 *   node scripts/e2e/visual-spec-generator.js --force          # Re-analyze all
 *   node scripts/e2e/visual-spec-generator.js --skip-vision    # Screenshots only
 *   node scripts/e2e/visual-spec-generator.js --max-pages 20   # Limit pages
 *   node scripts/e2e/visual-spec-generator.js --roles developer,user,reviewer  # Multi-role crawl
 */

try {
  require("dotenv").config({ path: ".env.local", quiet: true });
} catch { /* dotenv not installed */ }

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { logTokenUsage } = require("./lib/token-logger");

const ROOT = path.resolve(__dirname, "..", "..");

// Resolve E2E credentials: pool config > env vars > hardcoded fallback
let RESOLVED_DEV_EMAIL = process.env.E2E_DEVELOPER_EMAIL;
let RESOLVED_DEV_PASSWORD = process.env.E2E_DEVELOPER_PASSWORD;
if (!RESOLVED_DEV_EMAIL) {
  try {
    const poolConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "e2e", "pool-config.json"), "utf-8"));
    if (poolConfig.entries && poolConfig.entries[0]) {
      RESOLVED_DEV_EMAIL = poolConfig.entries[0].dev.email;
      RESOLVED_DEV_PASSWORD = poolConfig.entries[0].dev.password;
    }
  } catch { /* no pool config */ }
}
if (!RESOLVED_DEV_EMAIL) {
  RESOLVED_DEV_EMAIL = "developer@changepilot.test";
  RESOLVED_DEV_PASSWORD = "TestPassword123!";
}

const DOCS_DIR = path.join(ROOT, "docs", "visual-spec");
const PAGES_DIR = path.join(DOCS_DIR, "pages");
const SCREENSHOTS_DIR = path.join(DOCS_DIR, "screenshots");
const STATE_FILE = path.join(ROOT, "e2e", "state", "visual-spec.json");
const CACHE_FILE = path.join(ROOT, "e2e", "state", "visual-spec-cache.json");

// CLI args
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const forceAll = args.includes("--force");
const skipVision = args.includes("--skip-vision");
const routeFilter = args.includes("--routes") ? args[args.indexOf("--routes") + 1] : null;
const maxPagesArg = args.includes("--max-pages") ? parseInt(args[args.indexOf("--max-pages") + 1], 10) : 0;
const rolesArg = args.includes("--roles") ? args[args.indexOf("--roles") + 1] : "developer";
const requestedRoles = rolesArg.split(",").map(r => r.trim()).filter(Boolean);

const BASE_URL = process.env.BASE_URL || "https://moc-ai.vercel.app";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VISION_KEY = GEMINI_API_KEY ?? OPENAI_API_KEY;

// Filter out "no issues found" false positives from vision model responses
const NO_ISSUE_PATTERNS = /^no\s+(visible\s+)?issues?|^none|^n\/a|^contrast\s+(appears?\s+)?sufficient/i;

// ---------------------------------------------------------------------------
// Route map: every visitable route in the app, grouped by section
// Routes with [id] use a placeholder MOC — we skip those without context
// ---------------------------------------------------------------------------
const ROUTE_SECTIONS = {
  "Public Pages": [
    "/",
    "/login",
    "/pricing",
    "/contact",
    "/help",
    "/help/getting-started",
    "/help/creating-mocs",
    "/help/reviewing-mocs",
    "/help/workflow",
  ],
  "Onboarding": [
    "/setup-profile",
    "/enter-organization-key",
    "/select-organization",
    "/free-onboarding",
    "/getting-started",
  ],
  "Dashboard & MOC List": [
    "/mocs",
    "/mocs/completed",
    "/mocs/portfolio",
    "/mocs/new",
    "/mocs/new/guided",
  ],
  "Review Workflows": [
    "/review/role-inbox",
    "/review/cursory",
  ],
  "User Pages": [
    "/account/settings",
    "/my-department",
  ],
  "Admin - Settings": [
    "/admin",
    "/admin/departments",
    "/admin/sites",
    "/admin/change-areas",
    "/admin/change-definitions",
    "/admin/routing-config",
    "/admin/stage3-policy",
    "/admin/people",
    "/admin/permissions",
    "/admin/onboarding",
    "/admin/features",
    "/admin/checklist",
    "/admin/guidance",
  ],
  "Admin - Intelligence": [
    "/admin/settings/intelligence",
    "/admin/workflow-intelligence",
    "/admin/industry-intelligence",
  ],
  "Admin - Analytics": [
    "/admin/analytics",
    "/admin/analytics/feature-usage",
    "/admin/analytics/reviewer-patterns",
    "/admin/analytics/risk-patterns",
  ],
  "Admin - Risk & Compliance": [
    "/admin/risks",
    "/admin/residual-risks",
    "/admin/risk-perspectives",
    "/admin/compliance",
    "/admin/hotspot-library",
  ],
  "Admin - Advanced": [
    "/admin/workflow-automation",
    "/admin/autonomous-operations",
    "/admin/integrations",
    "/admin/webhooks",
    "/admin/api-keys",
    "/admin/agents",
  ],
  "Admin - System": [
    "/admin/mocs",
    "/admin/audit-log",
    "/admin/errors",
    "/admin/subscription",
    "/admin/security",
    "/admin/feedback",
  ],
  "Admin - Developer": [
    "/admin/developer",
    "/admin/developer/permissions",
    "/admin/super-admin",
  ],
};

// Map routes to BUILD-SPEC.md sections for cross-referencing
const ROUTE_TO_BUILD_SPEC_SECTION = {
  "/": "1. Landing Page & Marketing",
  "/login": "2. Authentication & Onboarding",
  "/pricing": "1. Landing Page & Marketing",
  "/setup-profile": "2. Authentication & Onboarding",
  "/enter-organization-key": "2. Authentication & Onboarding",
  "/select-organization": "2. Authentication & Onboarding",
  "/free-onboarding": "2. Authentication & Onboarding",
  "/getting-started": "2. Authentication & Onboarding",
  "/mocs": "3. MOC Dashboard & List",
  "/mocs/completed": "3. MOC Dashboard & List",
  "/mocs/portfolio": "4. Portfolio & Analytics",
  "/mocs/new": "5. MOC Creation (Stage 0)",
  "/mocs/new/guided": "5. MOC Creation (Stage 0)",
  "/review/role-inbox": "9. Review Workflow (Stage 4)",
  "/review/cursory": "9. Review Workflow (Stage 4)",
  "/my-department": "12. Department Management",
  "/account/settings": "13. User Settings",
  "/admin": "14. Admin Dashboard",
  "/admin/departments": "12. Department Management",
  "/admin/sites": "15. Site Management",
  "/admin/permissions": "16. Permissions Matrix",
  "/admin/features": "17. Feature Flags",
  "/admin/people": "18. People Management",
  "/admin/stage3-policy": "8. Review Plan (Stage 3)",
  "/admin/settings/intelligence": "19. Intelligence Settings",
  "/admin/analytics": "4. Portfolio & Analytics",
  "/admin/risks": "20. Risk Management",
  "/admin/audit-log": "21. Audit & Compliance",
  "/admin/errors": "22. Error Monitoring",
};

// Flatten into ordered route list
function getAllRoutes() {
  const routes = [];
  for (const [section, paths] of Object.entries(ROUTE_SECTIONS)) {
    for (const p of paths) {
      routes.push({ path: p, section });
    }
  }
  return routes;
}

// Role-to-route mapping — limits crawl to relevant pages per role
const ROLE_ROUTE_PATTERNS = {
  developer: ["*"],  // all routes
  admin: ["/admin/"],
  dept_head: ["/mocs", "/review/", "/my-department"],
  reviewer: ["/mocs", "/review/", "/account/"],
  user: ["/mocs", "/account/"],
};

function routeMatchesRole(routePath, role) {
  const patterns = ROLE_ROUTE_PATTERNS[role] ?? ["*"];
  if (patterns.includes("*")) { return true; }
  return patterns.some(p => routePath === p || routePath.startsWith(p));
}

// Simulation swap: switch the test user's role via API
async function swapSimulationRole(page, role) {
  try {
    const response = await page.evaluate(async (swapRole) => {
      const res = await fetch("/api/admin/simulation/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: swapRole }),
      });
      return { ok: res.ok, status: res.status };
    }, role);
    if (!response.ok) {
      console.warn(`  [swap] Role swap to ${role} failed: ${response.status}`);
      return false;
    }
    // Wait for role change to propagate
    await page.waitForTimeout(1000);
    return true;
  } catch (err) {
    console.warn(`  [swap] Role swap error: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Screenshot cache — skip unchanged pages
// ---------------------------------------------------------------------------
function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")); } catch { /* ignore */ }
  }
  return { pages: {}, lastRun: null };
}

function saveCache(cache) {
  cache.lastRun = new Date().toISOString();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

function hashScreenshot(buffer) {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Vision analysis via Gemini (primary) or OpenAI (fallback)
// ---------------------------------------------------------------------------
async function analyzeScreenshot(base64, routePath, mode) {
  if (!VISION_KEY || skipVision) {
    return {
      purpose: "Vision analysis skipped (no API key or --skip-vision)",
      elements: [],
      dataShown: [],
      interactions: [],
      navigation: [],
      issues: [],
      accessibility: "",
    };
  }

  const prompt = `You are a product analyst documenting a SaaS application called ChangePilot (Management of Change platform).

Analyze this screenshot of the page at route "${routePath}" in ${mode} mode.

Respond in JSON with these fields:
{
  "purpose": "1-2 sentence description of what this page does and who uses it",
  "elements": ["list of key UI elements visible: headers, cards, tables, forms, buttons, etc."],
  "dataShown": ["what data/content is displayed: MOC counts, user names, status badges, etc."],
  "interactions": ["what a user can DO on this page: click buttons, fill forms, navigate, filter, etc."],
  "navigation": ["where the user can go FROM this page: links, buttons, breadcrumbs"],
  "issues": ["any visual issues: broken layout, cut-off text, contrast problems, empty states that look wrong"],
  "accessibility": "brief a11y observation: contrast, labels, focus indicators, etc."
}

Be specific and factual. Describe what you SEE, not what you assume.`;

  if (GEMINI_API_KEY) {
    const result = await analyzeWithGemini(base64, prompt, routePath);
    if (result) return result;
  }
  if (OPENAI_API_KEY) {
    console.warn(`  [vision] WARNING: falling back to OpenAI vision — Gemini primary failed for ${routePath}`);
    const result = await analyzeWithOpenAI(base64, prompt, routePath);
    if (result) return result;
  }
  return null;
}

async function analyzeWithGemini(base64, prompt, routePath) {
  const model = process.env.VISUAL_SPEC_GEMINI_MODEL ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: "image/png", data: base64 } },
          { text: prompt },
        ] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          maxOutputTokens: 1536,
        },
      }),
    });
    if (!response.ok) {
      console.warn(`  [vision] Gemini ${response.status} for ${routePath}`);
      return null;
    }
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text.replace(/^```json\n?/i, "").replace(/\n?```$/i, "").trim());
    const usage = data.usageMetadata ?? {};
    return { ...parsed, _tokens: { input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 } };
  } catch (err) {
    console.warn(`  [vision] Gemini error for ${routePath}: ${err.message}`);
    return null;
  }
}

async function analyzeWithOpenAI(base64, prompt, routePath) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
          { type: "text", text: prompt },
        ] }],
        max_tokens: 1536,
        temperature: 0.1,
      }),
    });
    if (!response.ok) {
      console.warn(`  [vision] OpenAI ${response.status} for ${routePath}`);
      return null;
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text.replace(/^```json\n?/i, "").replace(/\n?```$/i, "").trim());
    const usage = data.usage ?? {};
    return { ...parsed, _tokens: { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 } };
  } catch (err) {
    console.warn(`  [vision] OpenAI error for ${routePath}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Playwright crawler
// ---------------------------------------------------------------------------
async function crawlRoutes(routes) {
  // Playwright is installed in e2e/node_modules, not root
  const playwrightPath = path.join(ROOT, "e2e", "node_modules", "playwright");
  const { chromium } = require(playwrightPath);
  const cache = loadCache();
  const results = [];
  let tokensUsed = { input: 0, output: 0 };
  let skippedCache = 0;
  let analyzed = 0;

  const browser = await chromium.launch({ headless: true });

  // Create two contexts: light mode and dark mode
  const lightContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    ignoreHTTPSErrors: true,
  });
  const darkContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    ignoreHTTPSErrors: true,
  });

  // Sign in as developer on both contexts
  const E2E_DEV_EMAIL = RESOLVED_DEV_EMAIL;
  const E2E_DEV_PASSWORD = RESOLVED_DEV_PASSWORD;
  console.log(`  [auth] Using credentials: ${E2E_DEV_EMAIL}`);

  async function loginWithRetry(ctx, maxRetries = 3) {
    console.log(`  [auth] Logging in as ${E2E_DEV_EMAIL}`);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const loginPage = await ctx.newPage();
      try {
        await loginPage.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await loginPage.fill('input[type="email"], input[name="email"]', E2E_DEV_EMAIL);
        await loginPage.fill('input[type="password"], input[name="password"]', E2E_DEV_PASSWORD);
        await loginPage.click('button[type="submit"]');
        // Wait for redirect — could go to /mocs, /admin, /setup-profile, etc.
        await loginPage.waitForURL((url) => !url.toString().includes("/login"), { timeout: 15000 }).catch(() => {});
        const postLoginUrl = loginPage.url();
        if (!postLoginUrl.includes("/login")) {
          console.log(`  [auth] Login successful (attempt ${attempt}) — redirected to ${postLoginUrl.replace(BASE_URL, "")}`);
          await loginPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await loginPage.close();
          return true;
        }
        // Capture error message from the page for debugging
        const errorText = await loginPage.textContent('[role="alert"], .text-red-500, .error-message').catch(() => "");
        console.warn(`  [auth] Attempt ${attempt}/${maxRetries} — still on login page${errorText ? `: ${errorText.slice(0, 200)}` : ""}`);
      } catch (err) {
        console.warn(`  [auth] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      }
      await loginPage.close();
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`  [auth] Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    console.error(`  [auth] Login failed after ${maxRetries} attempts for ${E2E_DEV_EMAIL}`);
    return false;
  }

  for (const ctx of [lightContext, darkContext]) {
    await loginWithRetry(ctx);
  }

  // Public routes that don't need auth
  const publicRoutes = new Set(["/", "/login", "/pricing", "/contact",
    "/help", "/help/getting-started", "/help/creating-mocs",
    "/help/reviewing-mocs", "/help/workflow"]);

  let routeIndex = 0;
  for (const route of routes) {
    routeIndex++;
    const routeKey = route.path;
    console.log(`[${routeIndex}/${routes.length}] ${routeKey}...`);

    const screenshotResults = {};

    for (const [mode, context] of [["light", lightContext], ["dark", darkContext]]) {
      const page = await context.newPage();
      const url = `${BASE_URL}${routeKey}`;

      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });

        // Wait for content to settle — use networkidle for authenticated pages
        if (!publicRoutes.has(routeKey)) {
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        } else {
          await page.waitForTimeout(2000);
        }

        // Check if we got redirected to login (for auth-required pages)
        const finalUrl = page.url();
        const wasRedirected = finalUrl.includes("/login") && !publicRoutes.has(routeKey);

        if (wasRedirected) {
          console.log(`  [${mode}] Redirected to login — skipping`);
          await page.close();
          continue;
        }

        const status = response?.status() ?? 0;

        // Take screenshot
        const screenshotBuffer = await page.screenshot({ fullPage: false });
        const screenshotHash = hashScreenshot(screenshotBuffer);

        // Check cache
        const cacheKey = `${routeKey}:${mode}`;
        const cached = cache.pages[cacheKey];
        if (cached && cached.hash === screenshotHash && !forceAll) {
          console.log(`  [${mode}] Unchanged (cached)`);
          skippedCache++;
          screenshotResults[mode] = {
            cached: true,
            hash: screenshotHash,
            analysis: cached.analysis,
            status,
          };
          await page.close();
          continue;
        }

        // Save screenshot
        const safeName = routeKey.replace(/\//g, "_").replace(/^_/, "") || "home";
        const screenshotName = `${safeName}_${mode}.png`;
        const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);
        fs.writeFileSync(screenshotPath, screenshotBuffer);

        // Vision analysis
        const base64 = screenshotBuffer.toString("base64");
        const analysis = await analyzeScreenshot(base64, routeKey, mode);

        if (analysis?._tokens) {
          tokensUsed.input += analysis._tokens.input;
          tokensUsed.output += analysis._tokens.output;
          delete analysis._tokens;
        }

        // Update cache
        cache.pages[cacheKey] = {
          hash: screenshotHash,
          analysis,
          status,
          analyzedAt: new Date().toISOString(),
        };

        screenshotResults[mode] = {
          cached: false,
          hash: screenshotHash,
          screenshotName,
          analysis,
          status,
        };

        analyzed++;
      } catch (err) {
        console.warn(`  [${mode}] Error: ${err.message}`);
        screenshotResults[mode] = { error: err.message };
      }

      await page.close();
    }

    results.push({
      path: routeKey,
      section: route.section,
      ...screenshotResults,
    });
  }

  await browser.close();
  saveCache(cache);

  return { results, tokensUsed, analyzed, skippedCache };
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------
function generatePageMarkdown(result) {
  const { path: routePath, section, light, dark } = result;
  const safeName = routePath.replace(/\//g, "_").replace(/^_/, "") || "home";

  let md = `# ${routePath}\n\n`;
  md += `**Section:** ${section}\n\n`;

  for (const [mode, data] of [["Light Mode", light], ["Dark Mode", dark]]) {
    if (!data || data.error) {
      md += `## ${mode}\n\n`;
      md += data?.error ? `*Error: ${data.error}*\n\n` : `*Not captured*\n\n`;
      continue;
    }

    md += `## ${mode}\n\n`;

    if (data.screenshotName) {
      md += `![${routePath} ${mode}](../screenshots/${data.screenshotName})\n\n`;
    } else if (data.cached) {
      const cachedName = `${safeName}_${mode === "Light Mode" ? "light" : "dark"}.png`;
      md += `![${routePath} ${mode}](../screenshots/${cachedName})\n\n`;
    }

    if (data.status) {
      md += `**HTTP Status:** ${data.status}\n\n`;
    }

    const a = data.analysis;
    if (a) {
      if (a.purpose) {
        md += `**Purpose:** ${a.purpose}\n\n`;
      }
      if (a.elements?.length) {
        md += `**Key Elements:**\n`;
        for (const el of a.elements) { md += `- ${el}\n`; }
        md += "\n";
      }
      if (a.dataShown?.length) {
        md += `**Data Shown:**\n`;
        for (const d of a.dataShown) { md += `- ${d}\n`; }
        md += "\n";
      }
      if (a.interactions?.length) {
        md += `**User Interactions:**\n`;
        for (const i of a.interactions) { md += `- ${i}\n`; }
        md += "\n";
      }
      if (a.navigation?.length) {
        md += `**Navigation:**\n`;
        for (const n of a.navigation) { md += `- ${n}\n`; }
        md += "\n";
      }
      if (a.issues?.length) {
        md += `**Issues Found:**\n`;
        for (const issue of a.issues) { md += `- ${issue}\n`; }
        md += "\n";
      }
      if (a.accessibility) {
        md += `**Accessibility:** ${a.accessibility}\n\n`;
      }
    }
  }

  md += `---\n*Generated: ${new Date().toISOString()}*\n`;
  return md;
}

function generateIndexMarkdown(results, stats) {
  let md = `# ChangePilot Visual Specification\n\n`;
  md += `> Auto-generated build spec of every page in the application.\n`;
  md += `> Screenshots taken in both light and dark mode with AI analysis.\n`;
  md += `> Review this document to identify discrepancies, missing features, or UI issues.\n\n`;

  md += `## Stats\n\n`;
  md += `- **Pages crawled:** ${results.length}\n`;
  md += `- **Screenshots analyzed:** ${stats.analyzed}\n`;
  md += `- **Cached (unchanged):** ${stats.skippedCache}\n`;
  md += `- **Tokens used:** ${stats.tokensUsed.input + stats.tokensUsed.output} (in: ${stats.tokensUsed.input}, out: ${stats.tokensUsed.output})\n`;
  md += `- **Generated:** ${new Date().toISOString()}\n\n`;

  // Group by section
  const sections = {};
  for (const r of results) {
    if (!sections[r.section]) { sections[r.section] = []; }
    sections[r.section].push(r);
  }

  md += `## Table of Contents\n\n`;
  for (const [section, pages] of Object.entries(sections)) {
    md += `### ${section}\n\n`;
    for (const page of pages) {
      const safeName = page.path.replace(/\//g, "_").replace(/^_/, "") || "home";
      const purpose = page.light?.analysis?.purpose || page.dark?.analysis?.purpose || "";
      const statusIcon = (page.light?.error || page.dark?.error) ? "!" : "";
      const issues = [
        ...(page.light?.analysis?.issues ?? []),
        ...(page.dark?.analysis?.issues ?? []),
      ];
      const issueTag = issues.length > 0 ? ` (${issues.length} issues)` : "";
      md += `| [${page.path}](pages/${safeName}.md) | ${purpose.slice(0, 80)}${statusIcon}${issueTag} |\n`;
    }
    md += "\n";
  }

  // Issues summary — filter out "no issues" false positives from vision model
  const allIssues = [];
  for (const r of results) {
    for (const mode of ["light", "dark"]) {
      const data = r[mode];
      if (data?.analysis?.issues?.length) {
        for (const issue of data.analysis.issues) {
          if (!NO_ISSUE_PATTERNS.test(issue.trim())) {
            allIssues.push({ path: r.path, mode, issue });
          }
        }
      }
    }
  }

  if (allIssues.length > 0) {
    md += `## Issues Found (${allIssues.length})\n\n`;
    md += `| Page | Mode | Issue |\n|------|------|-------|\n`;
    for (const { path: p, mode, issue } of allIssues) {
      md += `| ${p} | ${mode} | ${issue} |\n`;
    }
    md += "\n";
  }

  md += `---\n*Generated by visual-spec-generator.js*\n`;
  return md;
}

// ---------------------------------------------------------------------------
// Persona-readable JSON spec
// ---------------------------------------------------------------------------
function generateSpecJson(results, roleResults) {
  const spec = {
    version: 2,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    roles: requestedRoles,
    pages: {},
    sections: {},
    issues: [],
  };

  for (const r of results) {
    const lightAnalysis = r.light?.analysis ?? {};
    const darkAnalysis = r.dark?.analysis ?? {};

    const pageSpec = {
      section: r.section,
      buildSpecSection: ROUTE_TO_BUILD_SPEC_SECTION[r.path] ?? null,
      purpose: lightAnalysis.purpose || darkAnalysis.purpose || "",
      elements: [...new Set([...(lightAnalysis.elements ?? []), ...(darkAnalysis.elements ?? [])])],
      dataShown: [...new Set([...(lightAnalysis.dataShown ?? []), ...(darkAnalysis.dataShown ?? [])])],
      interactions: [...new Set([...(lightAnalysis.interactions ?? []), ...(darkAnalysis.interactions ?? [])])],
      navigation: [...new Set([...(lightAnalysis.navigation ?? []), ...(darkAnalysis.navigation ?? [])])],
      lightIssues: (lightAnalysis.issues ?? []).filter(i => !NO_ISSUE_PATTERNS.test(i.trim())),
      darkIssues: (darkAnalysis.issues ?? []).filter(i => !NO_ISSUE_PATTERNS.test(i.trim())),
      accessibility: lightAnalysis.accessibility || darkAnalysis.accessibility || "",
      lastAnalyzed: new Date().toISOString(),
    };

    // Add role-specific data if available
    const roles = roleResults?.[r.path];
    if (roles && Object.keys(roles).length > 0) {
      pageSpec.roles = roles;
    }

    spec.pages[r.path] = pageSpec;

    if (!spec.sections[r.section]) { spec.sections[r.section] = []; }
    spec.sections[r.section].push(r.path);

    for (const mode of ["light", "dark"]) {
      const analysis = r[mode]?.analysis;
      if (analysis?.issues?.length) {
        for (const issue of analysis.issues) {
          spec.issues.push({ path: r.path, mode, issue, severity: "visual" });
        }
      }
    }
  }

  return spec;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("[visual-spec] Starting visual spec generation...");
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  Vision: ${VISION_KEY ? `enabled (${GEMINI_API_KEY ? "Gemini" : "OpenAI"})` : "disabled (no GEMINI_API_KEY or OPENAI_API_KEY)"}`);

  // Ensure directories exist
  for (const dir of [DOCS_DIR, PAGES_DIR, SCREENSHOTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Get routes
  let routes = getAllRoutes();

  if (routeFilter) {
    routes = routes.filter(r => r.path.startsWith(routeFilter));
    console.log(`  Filtered to ${routes.length} routes matching "${routeFilter}"`);
  }

  if (maxPagesArg > 0) {
    routes = routes.slice(0, maxPagesArg);
    console.log(`  Limited to ${routes.length} pages (--max-pages ${maxPagesArg})`);
  }

  console.log(`  Routes to crawl: ${routes.length}\n`);

  if (dryRun) {
    for (const r of routes) {
      console.log(`  ${r.section}: ${r.path}`);
    }
    console.log("\n[visual-spec] Dry run complete.");
    return;
  }

  // Crawl and analyze — developer role (default)
  console.log(`  Roles: ${requestedRoles.join(", ")}`);
  const { results, tokensUsed, analyzed, skippedCache } = await crawlRoutes(routes);

  // Multi-role crawling: for non-developer roles, re-crawl relevant routes via simulation swap
  const roleResults = {};
  const additionalRoles = requestedRoles.filter(r => r !== "developer");
  if (additionalRoles.length > 0) {
    console.log(`\n[visual-spec] Multi-role crawling: ${additionalRoles.join(", ")}...`);
    const playwrightPath = path.join(ROOT, "e2e", "node_modules", "playwright");
    const { chromium } = require(playwrightPath);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "light",
      ignoreHTTPSErrors: true,
    });

    // Sign in as developer (with retry) — reuse resolved credentials
    const E2E_DEV_EMAIL_2 = RESOLVED_DEV_EMAIL;
    const E2E_DEV_PASSWORD_2 = RESOLVED_DEV_PASSWORD;
    let loginPage;
    let roleCrawlLoggedIn = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      loginPage = await context.newPage();
      try {
        await loginPage.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await loginPage.fill('input[type="email"], input[name="email"]', E2E_DEV_EMAIL_2);
        await loginPage.fill('input[type="password"], input[name="password"]', E2E_DEV_PASSWORD_2);
        await loginPage.click('button[type="submit"]');
        await loginPage.waitForURL("**/mocs**", { timeout: 15000 }).catch(() => {});
        const postUrl = loginPage.url();
        if (!postUrl.includes("/login")) {
          console.log(`  [auth] Role crawl login successful (attempt ${attempt})`);
          await loginPage.waitForTimeout(2000);
          roleCrawlLoggedIn = true;
          break;
        }
        console.warn(`  [auth] Role crawl attempt ${attempt}/3 — still on login`);
      } catch (err) {
        console.warn(`  [auth] Role crawl attempt ${attempt}/3 failed: ${err.message}`);
      }
      await loginPage.close();
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }

    if (!roleCrawlLoggedIn) {
      console.warn(`  [auth] Skipping role crawl — login failed after retries`);
    }

    for (const role of (roleCrawlLoggedIn ? additionalRoles : [])) {
      console.log(`\n  [role: ${role}] Swapping simulation role...`);
      const swapped = await swapSimulationRole(loginPage, role);
      if (!swapped) {
        console.warn(`  [role: ${role}] Swap failed, skipping`);
        continue;
      }

      const roleRoutes = routes.filter(r => routeMatchesRole(r.path, role));
      console.log(`  [role: ${role}] Crawling ${roleRoutes.length} routes...`);

      for (const route of roleRoutes) {
        const page = await context.newPage();
        try {
          const response = await page.goto(`${BASE_URL}${route.path}`, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
          await page.waitForTimeout(2000);

          const finalUrl = page.url();
          if (finalUrl.includes("/login")) {
            console.log(`    ${route.path} -> redirected to login (skip)`);
            await page.close();
            continue;
          }

          const screenshotBuffer = await page.screenshot({ fullPage: false });
          const base64 = screenshotBuffer.toString("base64");
          const analysis = await analyzeScreenshot(base64, route.path, `${role}-light`);

          if (analysis?._tokens) {
            tokensUsed.input += analysis._tokens.input;
            tokensUsed.output += analysis._tokens.output;
            delete analysis._tokens;
          }

          if (!roleResults[route.path]) { roleResults[route.path] = {}; }
          roleResults[route.path][role] = {
            purpose: analysis?.purpose || "",
            elements: analysis?.elements || [],
            dataShown: analysis?.dataShown || [],
            interactions: analysis?.interactions || [],
            issues: (analysis?.issues || []).filter(i => !NO_ISSUE_PATTERNS.test(i.trim())),
          };
          console.log(`    ${route.path} -> analyzed`);
        } catch (err) {
          console.warn(`    ${route.path} -> error: ${err.message}`);
        }
        await page.close();
      }
    }

    await loginPage.close();
    await browser.close();
  }

  console.log(`\n[visual-spec] Crawl complete:`);
  console.log(`  Analyzed: ${analyzed}`);
  console.log(`  Cached (unchanged): ${skippedCache}`);
  console.log(`  Tokens: ${tokensUsed.input + tokensUsed.output} (in: ${tokensUsed.input}, out: ${tokensUsed.output})`);

  // Log accumulated token usage to central tracker
  if (tokensUsed.input > 0 || tokensUsed.output > 0) {
    const visionProvider = GEMINI_API_KEY ? "gemini" : "openai";
    const visionModel = GEMINI_API_KEY
      ? (process.env.VISUAL_SPEC_GEMINI_MODEL ?? "gemini-2.5-flash")
      : "gpt-4o-mini";
    logTokenUsage({
      component: "visual-spec-generator",
      inputTokens: tokensUsed.input,
      outputTokens: tokensUsed.output,
      provider: visionProvider,
      model: visionModel,
    });
  }

  // Generate per-page markdown
  for (const result of results) {
    const safeName = result.path.replace(/\//g, "_").replace(/^_/, "") || "home";
    const pageMarkdown = generatePageMarkdown(result);
    fs.writeFileSync(path.join(PAGES_DIR, `${safeName}.md`), pageMarkdown, "utf-8");
  }

  // Generate index
  const indexMarkdown = generateIndexMarkdown(results, { analyzed, skippedCache, tokensUsed });
  fs.writeFileSync(path.join(DOCS_DIR, "VISUAL-SPEC.md"), indexMarkdown, "utf-8");

  // Generate persona-readable JSON (with role-keyed data)
  const specJson = generateSpecJson(results, roleResults);
  fs.writeFileSync(STATE_FILE, JSON.stringify(specJson, null, 2), "utf-8");

  console.log(`\n[visual-spec] Output:`);
  console.log(`  Index: docs/visual-spec/VISUAL-SPEC.md`);
  console.log(`  Pages: docs/visual-spec/pages/ (${results.length} files)`);
  console.log(`  Screenshots: docs/visual-spec/screenshots/`);
  console.log(`  Persona JSON: e2e/state/visual-spec.json`);
  console.log(`  Cache: e2e/state/visual-spec-cache.json`);
  if (additionalRoles.length > 0) {
    console.log(`  Roles crawled: ${requestedRoles.join(", ")}`);
  }
}

main().catch(err => {
  console.error("[visual-spec] Fatal error:", err);
  process.exit(1);
});
