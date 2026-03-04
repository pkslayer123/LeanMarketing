#!/usr/bin/env node

/**
 * Visual Test Script
 *
 * Takes screenshots of key pages using Playwright, sends them to an LLM (Gemini)
 * for visual quality assessment, and creates findings that feed into the
 * finding-pipeline → MOC → fix-engine cycle.
 *
 * Usage: node scripts/e2e/visual-test.js
 * Env: GEMINI_API_KEY (required), BASE_URL (optional, defaults to persona-engine.json)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const STATE_DIR = path.join(ROOT, "e2e", "state");
const SCREENSHOTS_DIR = path.join(STATE_DIR, "screenshots");

// Pages to screenshot and assess
const PAGES = [
  { path: "/", label: "Landing / Root" },
  { path: "/auth/login", label: "Login Page" },
  { path: "/auth/signup", label: "Signup Page" },
  { path: "/dashboard", label: "Dashboard" },
  { path: "/settings", label: "Settings" },
];

async function getBaseUrl() {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(ROOT, "persona-engine.json"), "utf-8")
    );
    return config.baseUrl || "https://leanmarketing.vercel.app";
  } catch {
    return process.env.BASE_URL || "https://leanmarketing.vercel.app";
  }
}

async function takeScreenshots() {
  // Dynamic import for ES module playwright
  let chromium;
  try {
    const pw = require(
      path.join(ROOT, "e2e", "node_modules", "playwright")
    );
    chromium = pw.chromium;
  } catch {
    try {
      const pw = require("playwright");
      chromium = pw.chromium;
    } catch {
      console.error("Playwright not found. Install in e2e/node_modules or globally.");
      return [];
    }
  }

  const baseUrl = await getBaseUrl();
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const results = [];

  for (const page of PAGES) {
    const p = await context.newPage();
    const url = `${baseUrl}${page.path}`;
    const screenshotPath = path.join(
      SCREENSHOTS_DIR,
      `${page.label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.png`
    );

    try {
      console.log(`Screenshotting: ${url}`);
      await p.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      await p.waitForTimeout(1000); // Let animations settle
      await p.screenshot({ path: screenshotPath, fullPage: true });

      results.push({
        page: page.path,
        label: page.label,
        screenshotPath,
        url: p.url(), // Capture actual URL (may have redirected)
        ok: true,
      });
    } catch (err) {
      console.error(`Failed to screenshot ${url}: ${err.message}`);
      results.push({
        page: page.path,
        label: page.label,
        screenshotPath: null,
        url,
        ok: false,
        error: err.message,
      });
    }

    await p.close();
  }

  await browser.close();
  return results;
}

async function assessWithLlm(screenshots) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("No GEMINI_API_KEY — skipping LLM visual assessment");
    return screenshots.map((s) => ({
      ...s,
      score: null,
      assessment: "Skipped (no API key)",
      issues: [],
    }));
  }

  const results = [];

  for (const shot of screenshots) {
    if (!shot.ok || !shot.screenshotPath) {
      results.push({ ...shot, score: 0, assessment: "Failed to load", issues: ["Page failed to load"] });
      continue;
    }

    try {
      const imageData = fs.readFileSync(shot.screenshotPath);
      const base64 = imageData.toString("base64");

      const prompt = `You are a UI/UX expert reviewing a screenshot of a SaaS web application called "LeanMarketing".

Rate this page on a scale of 1-10 for:
1. Visual Quality (styling, layout, spacing, color scheme)
2. Functionality (does it look like a working app with real features?)
3. Completeness (is this a full implementation or placeholder/stub?)

Page: ${shot.label} (${shot.page})
Actual URL: ${shot.url}

Respond in JSON format only:
{
  "visualScore": <1-10>,
  "functionalityScore": <1-10>,
  "completenessScore": <1-10>,
  "overallScore": <1-10>,
  "issues": ["issue 1", "issue 2"],
  "summary": "one sentence summary"
}`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: "image/png",
                      data: base64,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 500,
            },
          }),
        }
      );

      if (!response.ok) {
        const err = await response.text();
        console.error(`Gemini API error for ${shot.label}: ${err.slice(0, 200)}`);
        results.push({ ...shot, score: null, assessment: "API error", issues: [] });
        continue;
      }

      const data = await response.json();
      const text =
        data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      // Parse JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        results.push({
          ...shot,
          score: parsed.overallScore,
          visualScore: parsed.visualScore,
          functionalityScore: parsed.functionalityScore,
          completenessScore: parsed.completenessScore,
          assessment: parsed.summary,
          issues: parsed.issues || [],
        });
      } else {
        results.push({ ...shot, score: null, assessment: text.slice(0, 200), issues: [] });
      }
    } catch (err) {
      console.error(`Assessment error for ${shot.label}: ${err.message}`);
      results.push({ ...shot, score: null, assessment: "Error", issues: [] });
    }

    // Rate limit: 1 request per second
    await new Promise((r) => setTimeout(r, 1000));
  }

  return results;
}

function createFindings(assessments) {
  const findings = [];

  for (const a of assessments) {
    if (a.score !== null && a.score < 6) {
      findings.push({
        id: `visual-${a.label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}-${Date.now()}`,
        severity: a.score <= 3 ? "critical" : "major",
        page: a.page,
        description: `Visual test: ${a.label} scored ${a.score}/10. ${a.assessment}`,
        issues: a.issues,
        source: "visual-test",
        createdAt: new Date().toISOString(),
        status: "new",
      });
    }

    // Also create findings for specific issues regardless of score
    for (const issue of a.issues || []) {
      if (issue.toLowerCase().includes("placeholder") ||
          issue.toLowerCase().includes("stub") ||
          issue.toLowerCase().includes("empty") ||
          issue.toLowerCase().includes("unstyled")) {
        findings.push({
          id: `visual-issue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          severity: "major",
          page: a.page,
          description: `Visual test issue on ${a.label}: ${issue}`,
          source: "visual-test",
          createdAt: new Date().toISOString(),
          status: "new",
        });
      }
    }
  }

  return findings;
}

function saveResults(assessments, findings) {
  // Save visual test report
  const reportPath = path.join(STATE_DIR, "visual-test-report.json");
  const report = {
    timestamp: new Date().toISOString(),
    pages: assessments.map((a) => ({
      page: a.page,
      label: a.label,
      url: a.url,
      score: a.score,
      visualScore: a.visualScore,
      functionalityScore: a.functionalityScore,
      completenessScore: a.completenessScore,
      assessment: a.assessment,
      issues: a.issues,
    })),
    averageScore:
      assessments.filter((a) => a.score !== null).length > 0
        ? (
            assessments
              .filter((a) => a.score !== null)
              .reduce((sum, a) => sum + a.score, 0) /
            assessments.filter((a) => a.score !== null).length
          ).toFixed(1)
        : null,
    findingsCreated: findings.length,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Visual test report saved: ${reportPath}`);

  // Append findings to findings.json
  if (findings.length > 0) {
    const findingsPath = path.join(STATE_DIR, "findings", "findings.json");
    fs.mkdirSync(path.dirname(findingsPath), { recursive: true });

    let existing = { findings: [] };
    try {
      existing = JSON.parse(fs.readFileSync(findingsPath, "utf-8"));
      if (!Array.isArray(existing.findings)) existing.findings = [];
    } catch { /* new file */ }

    existing.findings.push(...findings);
    fs.writeFileSync(findingsPath, JSON.stringify(existing, null, 2) + "\n");
    console.log(`${findings.length} visual findings added to ${findingsPath}`);
  }

  return report;
}

async function main() {
  console.log("=== Visual Test: Screenshot + LLM Assessment ===\n");

  console.log("Phase 1: Taking screenshots...");
  const screenshots = await takeScreenshots();
  console.log(`Captured ${screenshots.filter((s) => s.ok).length}/${screenshots.length} screenshots\n`);

  console.log("Phase 2: LLM visual assessment...");
  const assessments = await assessWithLlm(screenshots);

  console.log("\nPhase 3: Creating findings...");
  const findings = createFindings(assessments);

  console.log("\nPhase 4: Saving results...");
  const report = saveResults(assessments, findings);

  // Print summary
  console.log("\n=== Visual Test Summary ===");
  for (const a of assessments) {
    const scoreStr = a.score !== null ? `${a.score}/10` : "N/A";
    const status = a.score === null ? "?" : a.score >= 7 ? "PASS" : a.score >= 5 ? "WARN" : "FAIL";
    console.log(`  [${status}] ${a.label}: ${scoreStr} — ${a.assessment}`);
  }
  console.log(`\nAverage score: ${report.averageScore ?? "N/A"}`);
  console.log(`Findings created: ${findings.length}`);
}

main().catch((err) => {
  console.error(`Visual test failed: ${err.message}`);
  process.exit(1);
});
