#!/usr/bin/env node
// Quick standalone test of the new gap detection logic
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");

function walkDir(dir, maxDepth, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath, maxDepth, currentDepth + 1));
      } else {
        results.push(fullPath);
      }
    }
  } catch { /* ignore */ }
  return results;
}

function deepScan(codeAreas) {
  const missingFiles = [], thinFiles = [], existingFiles = [];
  let totalExpected = 0;
  for (const area of codeAreas) {
    const fullPath = path.join(ROOT, area);
    if (area.endsWith(".tsx") || area.endsWith(".ts") || area.endsWith(".js")) {
      totalExpected++;
      if (fs.existsSync(fullPath)) {
        const lines = fs.readFileSync(fullPath, "utf-8").split("\n").length;
        if (lines < 30) thinFiles.push({ path: area, lines });
        else existingFiles.push({ path: area, lines });
      } else missingFiles.push(area);
      continue;
    }
    // Directory
    let files = [];
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      const rawFiles = walkDir(fullPath, 2)
        .filter(f => f.endsWith(".ts") || f.endsWith(".tsx"));
      files = rawFiles.map(f => {
        const rel = path.relative(ROOT, f);
        return rel.split(path.sep).join("/");
      });
    }
    if (area === "app/auth/") {
      console.log("  DEBUG app/auth/ ->", "exists:", fs.existsSync(fullPath), "isDir:", fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory(), "files found:", files.length, files);
    }
    if (!files.length) {
      const c = area.replace(/\/$/, "");
      if (c.startsWith("app/api/")) files.push(c + "/route.ts");
      else if (c.startsWith("app/")) files.push(c + "/page.tsx");
      else if (c.startsWith("components/")) files.push(c + "/index.tsx");
      else if (c.startsWith("lib/")) files.push(c + "/index.ts");
      else files.push(c + "/index.ts");
    }
    totalExpected += files.length;
    for (const file of files) {
      const fp = path.join(ROOT, file);
      if (fs.existsSync(fp)) {
        const lines = fs.readFileSync(fp, "utf-8").split("\n").length;
        if (lines < 30) thinFiles.push({ path: file, lines });
        else existingFiles.push({ path: file, lines });
      } else missingFiles.push(file);
    }
  }
  const score = totalExpected > 0 ? existingFiles.length / totalExpected : 1;
  return { missingFiles, thinFiles, existingFiles, totalExpected, score: Math.round(score * 100) };
}

const features = [
  { name: "Auth", areas: ["app/auth/", "app/api/auth/", "lib/auth/", "components/AuthForm.tsx"] },
  { name: "Dashboard", areas: ["app/dashboard/", "app/api/projects/", "lib/projects/", "components/Dashboard/"] },
  { name: "Layer 1 Idea", areas: ["app/projects/[id]/idea/", "app/api/ideas/", "lib/ideas/", "components/IdeaForm/"] },
  { name: "Layer 2 Audience", areas: ["app/projects/[id]/audience/", "app/api/leads/", "app/api/outreach/", "lib/outreach/", "components/Outreach/"] },
  { name: "Layer 3 Conversations", areas: ["app/projects/[id]/conversations/", "app/api/conversations/", "lib/conversations/", "components/Conversations/"] },
  { name: "Layer 4 Proof", areas: ["app/projects/[id]/proof/", "app/api/proof/", "lib/proof/", "components/Proof/"] },
  { name: "Layer 5 Conversion", areas: ["app/projects/[id]/conversion/", "app/api/offers/", "lib/offers/", "components/Offers/"] },
  { name: "Layer 6 Review", areas: ["app/projects/[id]/review/", "app/api/analytics/", "lib/analytics/", "components/Analytics/"] },
  { name: "Database", areas: ["lib/database/", "supabase/migrations/"] },
  { name: "Settings", areas: ["app/settings/", "app/api/settings/", "lib/settings/", "components/Settings/"] },
];

let gapCount = 0;
for (const f of features) {
  const r = deepScan(f.areas);
  const isComplete = r.score >= 95 && r.thinFiles.length === 0;
  const status = isComplete ? "COMPLETE" : "GAP";
  if (!isComplete) gapCount++;
  console.log(`[${status}] ${f.name}: ${r.score}% (${r.existingFiles.length} good, ${r.thinFiles.length} thin, ${r.missingFiles.length} missing / ${r.totalExpected} total)`);
  if (r.missingFiles.length > 0) console.log(`  Missing: ${r.missingFiles.join(", ")}`);
  if (r.thinFiles.length > 0) console.log(`  Thin: ${r.thinFiles.map(t => t.path + " (" + t.lines + "L)").join(", ")}`);
}
console.log(`\n${gapCount} gaps detected out of ${features.length} features`);
