#!/usr/bin/env node

/**
 * page-to-source.js — Maps page paths to source files.
 *
 * Genericized version: reads route-map.json from e2e/state/ if it exists,
 * otherwise falls back to convention-based discovery (app/ directory structure).
 *
 * Used by:
 *   - findings-to-mocs.js (adds sourceFiles to new MOCs)
 *   - moc-auto-fix.js (resolves source files for fixes)
 *   - consolidate-themes.js (adds sourceFiles to theme MOCs)
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Project root detection — walks up from __dirname looking for config files
// ---------------------------------------------------------------------------

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
  return path.resolve(__dirname, "..", "..");
}

const ROOT = findProjectRoot();
const APP_DIR = path.join(ROOT, "app");

// ---------------------------------------------------------------------------
// Route map loading — config file with fallback to convention
// ---------------------------------------------------------------------------

/**
 * Load route-to-source-file mapping.
 * Reads e2e/state/route-map.json if it exists, otherwise returns empty map.
 * Convention fallback: /foo -> app/foo/page.tsx (handled in pagePathToSourceFiles).
 */
function loadRouteMap() {
  const mapPath = path.join(ROOT, "e2e", "state", "route-map.json");
  if (fs.existsSync(mapPath)) {
    try {
      return JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    } catch {
      // Corrupt route map — fall back to convention
    }
  }
  return {};
}

let _routeMap = null;
function getRouteMap() {
  if (_routeMap === null) {
    _routeMap = loadRouteMap();
  }
  return _routeMap;
}

/**
 * Map a page path (e.g., "/mocs", "/login", "/api/admin/people")
 * to an array of source file paths (absolute).
 */
function pagePathToSourceFiles(pagePath) {
  if (!pagePath) {
    return [];
  }

  // Strip query params
  const cleanPath = pagePath.split("?")[0];
  const routeMap = getRouteMap();

  // Direct match from route map
  if (routeMap[cleanPath]) {
    const fullPath = path.join(ROOT, routeMap[cleanPath]);
    if (fs.existsSync(fullPath)) {
      return [fullPath];
    }
  }

  // Dynamic detail pages: /thing/<uuid> -> app/thing/[id]/page.tsx
  const uuidMatch = cleanPath.match(/^(\/[^/]+)\/[0-9a-f-]{36}$/);
  if (uuidMatch) {
    const pageTsx = path.join(APP_DIR, uuidMatch[1].slice(1), "[id]", "page.tsx");
    if (fs.existsSync(pageTsx)) {
      return [pageTsx];
    }
  }

  // Nested dynamic pages: /thing/<uuid>/sub-path
  const nestedUuidMatch = cleanPath.match(/^(\/[^/]+)\/[0-9a-f-]{36}\/(.+)$/);
  if (nestedUuidMatch) {
    const pageTsx = path.join(APP_DIR, nestedUuidMatch[1].slice(1), "[id]", nestedUuidMatch[2], "page.tsx");
    if (fs.existsSync(pageTsx)) {
      return [pageTsx];
    }
  }

  // API routes: /api/... -> app/api/.../route.ts
  if (cleanPath.startsWith("/api/")) {
    const apiSegments = cleanPath.replace(/^\//, "").split("/");
    for (let i = apiSegments.length; i >= 2; i--) {
      const tryPath = path.join(APP_DIR, ...apiSegments.slice(0, i), "route.ts");
      if (fs.existsSync(tryPath)) {
        return [tryPath];
      }
    }
    // Scan for closest sub-routes
    const apiDir = path.join(APP_DIR, ...apiSegments);
    if (fs.existsSync(apiDir)) {
      try {
        const subRoutes = [];
        const scanDir = (dir, depth = 0) => {
          if (depth > 2) { return; }
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name === "route.ts") {
              subRoutes.push(path.join(dir, entry.name));
            } else if (entry.isDirectory() && depth < 2) {
              scanDir(path.join(dir, entry.name), depth + 1);
            }
          }
        };
        scanDir(apiDir);
        if (subRoutes.length > 0) {
          return subRoutes.slice(0, 3);
        }
      } catch { /* ignore scan errors */ }
    }
  }

  // Convention-based filesystem discovery for pages
  const segments = cleanPath.replace(/^\//, "").split("/");
  for (let i = segments.length; i >= 1; i--) {
    const tryPath = path.join(APP_DIR, ...segments.slice(0, i), "page.tsx");
    if (fs.existsSync(tryPath)) {
      return [tryPath];
    }
  }

  return [];
}

/**
 * Find the API route file for a given page path.
 * Reads from route-map.json api mappings, or discovers via convention.
 */
function findApiRoute(pagePath) {
  const cleanPath = (pagePath || "").split("?")[0];
  const routeMap = getRouteMap();

  // Check route map for api_ prefixed keys or direct api mappings
  const apiKey = `api:${cleanPath}`;
  if (routeMap[apiKey]) {
    const fullPath = path.join(ROOT, routeMap[apiKey]);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Convention: /foo -> app/api/foo/route.ts
  if (!cleanPath.startsWith("/api/")) {
    const segments = cleanPath.replace(/^\//, "").split("/");
    const tryPath = path.join(APP_DIR, "api", ...segments, "route.ts");
    if (fs.existsSync(tryPath)) {
      return tryPath;
    }
  }

  // Direct API path
  if (cleanPath.startsWith("/api/")) {
    const segments = cleanPath.replace(/^\//, "").split("/");
    for (let i = segments.length; i >= 2; i--) {
      const tryPath = path.join(APP_DIR, ...segments.slice(0, i), "route.ts");
      if (fs.existsSync(tryPath)) {
        return tryPath;
      }
    }
  }

  return null;
}

/**
 * Convert absolute paths to relative paths (for storage in JSON).
 */
function toRelativePaths(absolutePaths) {
  return absolutePaths.map((p) => path.relative(ROOT, p).replace(/\\/g, "/"));
}

/**
 * Reload the route map from disk (e.g., after regeneration).
 */
function reloadRouteMap() {
  _routeMap = null;
}

module.exports = { pagePathToSourceFiles, findApiRoute, toRelativePaths, reloadRouteMap, ROOT };
