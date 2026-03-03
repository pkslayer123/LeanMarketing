#!/usr/bin/env node

/**
 * Sync manifest.json against permission keys and feature flags in the codebase.
 *
 * Modes:
 *   --check   (default) Report mismatches only
 *   --fix     Auto-add missing permissions/features to manifest.json
 *   --json    Output machine-readable JSON (for test-fix loop)
 *
 * Usage:
 *   node scripts/sync-manifest.js                  # Report only
 *   node scripts/sync-manifest.js --fix            # Auto-fix manifest
 *   node scripts/sync-manifest.js --fix --json     # Auto-fix + JSON output
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "e2e", "state", "manifest.json");
const PERMISSION_KEYS_PATH = path.join(ROOT, "lib", "permissions", "keys.ts");
const FEATURES_PATH = path.join(ROOT, "lib", "types", "features.ts");

const args = process.argv.slice(2);
const FIX_MODE = args.includes("--fix");
const JSON_MODE = args.includes("--json");
const ADD_MISSING_PERSONAS = args.includes("--add-missing-personas");

// ---------------------------------------------------------------------------
// Persona assignment rules — maps permission/feature prefixes to persona IDs
// ---------------------------------------------------------------------------

const PERSONA_ASSIGNMENT = {
  // By permission key prefix
  permission: {
    "stage_0": ["cliff-patience", "paige-turner", "frank-doorman"],
    "stage_1": ["cliff-patience", "paige-turner"],
    "stage_2": ["cliff-patience"],
    "stage_3": ["wanda-walls", "del-e-gate"],
    "stage_4": ["raj-diligence", "victor-veto", "maria-steadman"],
    "stage_5": ["wanda-walls"],
    "stage_6": ["cliff-patience"],
    "cross": ["cliff-patience", "frank-doorman"],
    "dept": ["wanda-walls", "del-e-gate"],
    "admin": ["sue-pervisor"],
    "super": ["grant-powers"],
    "dev": ["grant-powers"],
    "account": ["paige-turner", "cliff-patience"],
  },
  // By feature flag category keywords
  feature: {
    "moc_": ["cliff-patience", "paige-turner", "frank-doorman"],
    "analytics_": ["sue-pervisor"],
    "ai_": ["cliff-patience", "paige-turner"],
    "risk_": ["cliff-patience", "raj-diligence"],
    "admin_": ["sue-pervisor"],
    "department_": ["wanda-walls", "del-e-gate"],
    "compliance_": ["sue-pervisor", "grant-powers"],
    "audit_": ["sue-pervisor"],
    "security_": ["penny-tester", "frank-doorman"],
    "workflow_": ["cliff-patience", "raj-diligence"],
    "marketplace": ["sue-pervisor"],
    "iot_": ["sue-pervisor"],
    "onboarding": ["paige-turner"],
    "developer_": ["grant-powers"],
    "error_": ["penny-tester"],
    "sites_": ["sue-pervisor"],
    "global_": ["grant-powers"],
    "regional_": ["grant-powers"],
    "failover_": ["grant-powers"],
    "industry_": ["sue-pervisor"],
    "multitenancy": ["grant-powers"],
    "sso": ["penny-tester", "sue-pervisor"],
    "mfa": ["penny-tester", "sue-pervisor"],
    "webhooks": ["penny-tester"],
    "api_keys": ["penny-tester"],
    "custom_reports": ["sue-pervisor"],
    "executive_": ["sue-pervisor"],
    "smart_": ["cliff-patience"],
    "process_": ["sue-pervisor"],
    "scope_": ["cliff-patience"],
    "sensor_": ["sue-pervisor"],
    "approval_": ["wanda-walls"],
    "escalation_": ["wanda-walls"],
    "autonomous_": ["sue-pervisor"],
    "user_management": ["sue-pervisor"],
    "organization_": ["sue-pervisor"],
  },
};

// Default permission values by role for new keys
const DEFAULT_PERM_BY_ROLE = {
  user: false,
  reviewer: false,
  dept_head: false,
  admin: true,
  super_admin: true,
};

// Smarter defaults based on key prefix
function getDefaultPermValue(role, permKey) {
  const prefix = permKey.split(".")[0];
  if (prefix === "stage_0" || prefix === "stage_1") {
    // All roles can create/view MOCs
    if (permKey.includes("view") || permKey.includes("create") || permKey.includes("edit")) {
      return true;
    }
  }
  if (prefix === "account") {
    return true; // All roles can manage their own account
  }
  if (prefix === "super") {
    return role === "super_admin";
  }
  if (prefix === "dev") {
    return false; // Only developers (not in manifest roles)
  }
  return DEFAULT_PERM_BY_ROLE[role] ?? false;
}

// Assign personas for a feature flag based on keyword matching
function assignPersonasForFeature(featureKey) {
  for (const [keyword, personas] of Object.entries(PERSONA_ASSIGNMENT.feature)) {
    if (featureKey.startsWith(keyword) || featureKey === keyword) {
      return personas;
    }
  }
  // Default: assign cliff (submitter) and sue (admin)
  return ["cliff-patience", "sue-pervisor"];
}

// Assign feature to a manifest feature group based on key prefix
function guessFeatureGroup(featureKey) {
  const prefixMap = {
    "moc_": "moc_workflow",
    "ai_": "admin_config",
    "analytics_": "admin_monitoring",
    "risk_": "moc_hotspots",
    "admin_": "admin_config",
    "department_": "department_management",
    "compliance_": "admin_monitoring",
    "audit_": "admin_monitoring",
    "security_": "security",
    "workflow_": "moc_workflow",
  };
  for (const [prefix, group] of Object.entries(prefixMap)) {
    if (featureKey.startsWith(prefix)) {
      return group;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extract keys from source
// ---------------------------------------------------------------------------

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
}

function extractPermissionKeys() {
  const content = fs.readFileSync(PERMISSION_KEYS_PATH, "utf-8");
  const keys = new Set();
  const regex = /["']([a-z_]+\.[a-z_]+)["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    keys.add(match[1]);
  }
  return Array.from(keys);
}

function extractFeatureFlags() {
  const content = fs.readFileSync(FEATURES_PATH, "utf-8");
  const flags = new Set();
  const regex = /:\s*["']([a-z_]+)["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    flags.add(match[1]);
  }
  return Array.from(flags);
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

const manifest = loadManifest();
const results = {
  permissionsAdded: [],
  featuresAdded: [],
  permissionsInCode: 0,
  permissionsInManifest: 0,
  featuresInCode: 0,
  featuresInManifest: 0,
  missingPermissions: [],
  missingFeatures: [],
};

// --- Permission sync ---
const codePermKeys = extractPermissionKeys();
const manifestPermKeys = new Set();
for (const role of Object.values(manifest.roles)) {
  for (const key of Object.keys(role.expectedPermissions)) {
    manifestPermKeys.add(key);
  }
}

results.permissionsInCode = codePermKeys.length;
results.permissionsInManifest = manifestPermKeys.size;

const missingPerms = codePermKeys.filter((k) => !manifestPermKeys.has(k));
results.missingPermissions = missingPerms;

if (FIX_MODE && missingPerms.length > 0) {
  for (const key of missingPerms) {
    for (const [roleName, roleData] of Object.entries(manifest.roles)) {
      roleData.expectedPermissions[key] = getDefaultPermValue(roleName, key);
    }
    results.permissionsAdded.push(key);
  }
}

// --- Feature flag sync ---
const codeFlags = extractFeatureFlags();
const manifestFeatures = new Set(Object.keys(manifest.features));

results.featuresInCode = codeFlags.length;
results.featuresInManifest = manifestFeatures.size;

const missingFlags = codeFlags.filter((f) => !manifestFeatures.has(f));
results.missingFeatures = missingFlags;

if (FIX_MODE && missingFlags.length > 0) {
  for (const flag of missingFlags) {
    const personas = assignPersonasForFeature(flag);
    const pages = []; // Can't auto-detect pages, leave empty
    const permissions = []; // Auto-detect related permissions
    for (const pk of codePermKeys) {
      const flagSlug = flag.replace(/_/g, ".");
      if (pk.startsWith(flagSlug) || pk.includes(flag)) {
        permissions.push(pk);
      }
    }

    manifest.features[flag] = {
      permissions,
      personas,
      pages,
      codeAreas: [],
    };
    results.featuresAdded.push(flag);

    // Also try to add to an existing feature group if it fits
    // (This just enriches the existing groups, doesn't replace)
  }
}

// --- Persona sync: add spec-file personas missing from manifest ---
const personaSpecDir = path.join(ROOT, "e2e", "tests", "personas");
results.personasAdded = [];
results.personasAlreadyMapped = 0;

if (ADD_MISSING_PERSONAS || FIX_MODE) {
  try {
    const specFiles = fs.readdirSync(personaSpecDir).filter((f) => f.endsWith(".spec.ts"));
    const manifestPersonas = new Set();
    for (const feat of Object.values(manifest.features)) {
      for (const p of feat.personas || []) {
        manifestPersonas.add(p);
      }
    }
    results.personasAlreadyMapped = manifestPersonas.size;

    // Load PREFIX_TO_FEATURE from discover-routes.js for page → feature mapping
    const PREFIX_TO_FEATURE = {
      "/moc/": "moc_workflow", "/mocs/new": "moc_workflow", "/mocs/completed": "moc_closeout",
      "/mocs/portfolio": "moc_portfolio", "/mocs": "moc_workflow",
      "/admin/departments": "department_management", "/admin/people": "user_management",
      "/admin/permissions": "admin_config", "/admin/developer": "developer_tools",
      "/admin/analytics": "analytics", "/admin/features": "admin_config",
      "/admin/webhooks": "webhooks", "/admin/agents": "agentic_employees",
      "/admin/errors": "error_tracking", "/admin/audit-log": "audit_logs",
      "/admin/system-audit": "admin_monitoring", "/admin/security": "admin_security",
      "/admin": "admin_dashboard", "/review": "moc_review",
      "/account": "account_settings", "/my-department": "department_management",
    };

    for (const specFile of specFiles) {
      const personaId = specFile.replace(".spec.ts", "");
      if (manifestPersonas.has(personaId)) {
        continue;
      }

      // Scan spec file for page paths
      const specContent = fs.readFileSync(path.join(personaSpecDir, specFile), "utf-8");
      const pageRegex = /(?:page\.goto|sim\.navigateTo)\s*\(\s*['"`]([^'"`$]+)/g;
      const pages = new Set();
      let pageMatch;
      while ((pageMatch = pageRegex.exec(specContent)) !== null) {
        let pagePath = pageMatch[1].replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
        if (pagePath) {
          pages.add(pagePath);
        }
      }

      // Map pages to features using PREFIX_TO_FEATURE (longest prefix match)
      const features = new Set();
      for (const page of pages) {
        let bestMatch = "";
        let bestFeature = null;
        for (const [prefix, feat] of Object.entries(PREFIX_TO_FEATURE)) {
          if (page.startsWith(prefix) && prefix.length > bestMatch.length) {
            bestMatch = prefix;
            bestFeature = feat;
          }
        }
        if (bestFeature) {
          features.add(bestFeature);
        }
      }

      // Add persona to each matched feature
      if (features.size > 0) {
        for (const feat of features) {
          if (manifest.features[feat]) {
            const existing = new Set(manifest.features[feat].personas || []);
            if (!existing.has(personaId)) {
              manifest.features[feat].personas.push(personaId);
            }
          }
        }
        results.personasAdded.push({ persona: personaId, features: [...features] });
      }
    }
  } catch (err) {
    console.error("Persona sync error:", err.message);
  }
}

// --- Write manifest if anything changed ---
const hasChanges = results.permissionsAdded.length > 0 || results.featuresAdded.length > 0 || results.personasAdded.length > 0;
if ((FIX_MODE || ADD_MISSING_PERSONAS) && hasChanges) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

// --- Output ---
if (JSON_MODE) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("=== Permission Key Sync ===\n");
  console.log(`Permissions: ${codePermKeys.length} in code, ${manifestPermKeys.size} in manifest`);
  if (missingPerms.length > 0) {
    console.log(`\n${FIX_MODE ? "Added" : "Missing"} ${missingPerms.length} permission keys:`);
    for (const k of missingPerms) {
      console.log(`  ${FIX_MODE ? "+" : "!"} ${k}`);
    }
  } else {
    console.log("All permission keys in sync.");
  }

  console.log("\n=== Feature Flag Sync ===\n");
  console.log(`Features: ${codeFlags.length} in code, ${manifestFeatures.size} in manifest`);
  if (missingFlags.length > 0) {
    console.log(`\n${FIX_MODE ? "Added" : "Missing"} ${missingFlags.length} feature flags:`);
    for (const f of missingFlags) {
      const personas = assignPersonasForFeature(f);
      console.log(`  ${FIX_MODE ? "+" : "!"} ${f} → personas: [${personas.join(", ")}]`);
    }
  } else {
    console.log("All feature flags in sync.");
  }

  if (ADD_MISSING_PERSONAS || FIX_MODE) {
    console.log("\n=== Persona Sync ===\n");
    console.log(`Personas already mapped: ${results.personasAlreadyMapped}`);
    if (results.personasAdded.length > 0) {
      console.log(`Added ${results.personasAdded.length} personas:`);
      for (const entry of results.personasAdded) {
        console.log(`  + ${entry.persona} → [${entry.features.join(", ")}]`);
      }
    } else {
      console.log("All spec-file personas are in manifest.");
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Permissions: ${missingPerms.length} ${FIX_MODE ? "added" : "missing"}`);
  console.log(`Features: ${missingFlags.length} ${FIX_MODE ? "added" : "missing"}`);
  if (ADD_MISSING_PERSONAS || FIX_MODE) {
    console.log(`Personas: ${results.personasAdded.length} added`);
  }
  if (hasChanges) {
    console.log(`\nManifest updated: ${MANIFEST_PATH}`);
  }
}
