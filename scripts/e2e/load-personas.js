#!/usr/bin/env node

/**
 * Load personas from e2e/state/personas/*.yaml and *.json.
 * Returns array of Persona objects compatible with e2e/fixtures/personas.ts.
 *
 * Usage: node scripts/e2e/load-personas.js [--json]
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const ROOT = path.resolve(__dirname, "..", "..");
const PERSONAS_DIR = path.join(ROOT, "e2e", "state", "personas");

const ROLES = ["user", "reviewer", "dept_head", "admin", "super_admin", "developer"];

function loadPersonasFromConfig() {
  if (!fs.existsSync(PERSONAS_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(PERSONAS_DIR, { withFileTypes: true });
  const files = entries
    .filter(
      (e) =>
        e.isFile() &&
        (e.name.endsWith(".yaml") ||
          e.name.endsWith(".yml") ||
          e.name.endsWith(".json")) &&
        e.name !== "schema.json"
    )
    .map((e) => path.join(PERSONAS_DIR, e.name));

  const personas = [];
  const seenIds = new Set();

  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      let data;
      if (file.endsWith(".json")) {
        data = JSON.parse(raw);
      } else {
        data = yaml.load(raw);
      }

      if (Array.isArray(data)) {
        for (const p of data) {
          const persona = normalizePersona(p);
          if (persona && !seenIds.has(persona.id)) {
            seenIds.add(persona.id);
            personas.push(persona);
          }
        }
      } else if (data && typeof data === "object") {
        const persona = normalizePersona(data);
        if (persona && !seenIds.has(persona.id)) {
          seenIds.add(persona.id);
          personas.push(persona);
        }
      }
    } catch (err) {
      console.error("Failed to load " + path.basename(file) + ":", err.message);
    }
  }

  return personas;
}

function normalizePersona(p) {
  if (!p || !p.id || !p.fullName || !p.role || !p.personality || !p.focus) {
    return null;
  }
  if (!ROLES.includes(p.role)) {
    return null;
  }
  const focus = Array.isArray(p.focus) ? p.focus : [String(p.focus)];
  return {
    id: String(p.id).trim(),
    fullName: String(p.fullName).trim(),
    role: p.role,
    department: p.department ?? "",
    personality: String(p.personality).trim(),
    focus,
    viewportWidth: typeof p.viewportWidth === "number" ? p.viewportWidth : undefined,
    // role field is authoritative — no boolean flags needed
    traits: p.traits && typeof p.traits === "object" ? p.traits : undefined,
  };
}

function main() {
  const personas = loadPersonasFromConfig();
  const hasJson = process.argv.includes("--json");
  if (hasJson) {
    console.log(JSON.stringify(personas, null, 2));
  } else {
    console.log("Loaded " + personas.length + " persona(s) from config");
    for (const p of personas) {
      console.log("  - " + p.id + " (" + p.role + ")");
    }
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { loadPersonasFromConfig, normalizePersona };
}
