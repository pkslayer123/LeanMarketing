#!/usr/bin/env node

/**
 * Stack Adapter — Maps framework conventions for multi-stack support.
 *
 * The daemon's fix-engine and builder claws need to know where files live
 * and how routes map to code. This adapter provides framework-aware
 * path resolution, route file templates, and config detection.
 *
 * Supported stacks:
 *   - nextjs: Next.js App Router (app/), Pages Router (pages/)
 *   - vite-react: Vite + React (src/pages/ or src/routes/)
 *   - sveltekit: SvelteKit (src/routes/)
 *   - remix: Remix (app/routes/)
 *   - astro: Astro (src/pages/)
 *   - custom: Reads all paths from persona-engine.json
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

// ---------------------------------------------------------------------------
// Stack definitions
// ---------------------------------------------------------------------------

const STACKS = {
  nextjs: {
    name: "Next.js (App Router)",
    routeDir: "app",
    routeFile: "page.tsx",
    apiDir: "app/api",
    apiFile: "route.ts",
    layoutFile: "layout.tsx",
    componentDir: "components",
    libDir: "lib",
    configFiles: ["next.config.ts", "next.config.js", "next.config.mjs"],
    packageManager: "npm",
    buildCommand: "next build",
    devCommand: "next dev",
    authPatterns: {
      supabase: { clientFile: "lib/supabaseClient.ts", serverFile: "lib/supabaseServer.ts" },
      clerk: { middlewareImport: "@clerk/nextjs" },
      nextauth: { routeFile: "app/api/auth/[...nextauth]/route.ts" },
    },
    routeTemplate: (routePath, componentName) => `export default function ${componentName}() {
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-2xl font-bold">${componentName}</h1>
    </main>
  );
}
`,
    apiTemplate: (routePath) => `import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  return NextResponse.json({ message: "OK" });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  return NextResponse.json({ received: true });
}
`,
  },

  "vite-react": {
    name: "Vite + React",
    routeDir: "src/pages",
    routeFile: "index.tsx",
    apiDir: "src/api", // or server/api for full-stack
    apiFile: "index.ts",
    layoutFile: "Layout.tsx",
    componentDir: "src/components",
    libDir: "src/lib",
    configFiles: ["vite.config.ts", "vite.config.js"],
    packageManager: "npm",
    buildCommand: "vite build",
    devCommand: "vite",
    routeTemplate: (routePath, componentName) => `import React from "react";

export default function ${componentName}() {
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-2xl font-bold">${componentName}</h1>
    </main>
  );
}
`,
  },

  sveltekit: {
    name: "SvelteKit",
    routeDir: "src/routes",
    routeFile: "+page.svelte",
    apiDir: "src/routes/api",
    apiFile: "+server.ts",
    layoutFile: "+layout.svelte",
    componentDir: "src/lib/components",
    libDir: "src/lib",
    configFiles: ["svelte.config.js"],
    packageManager: "npm",
    buildCommand: "vite build",
    devCommand: "vite dev",
    authPatterns: {
      supabase: { clientFile: "src/lib/supabase.ts" },
    },
    routeTemplate: (routePath, componentName) => `<script lang="ts">
  // ${componentName} page
</script>

<main class="min-h-screen p-8">
  <h1 class="text-2xl font-bold">${componentName}</h1>
</main>
`,
    apiTemplate: (routePath) => `import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  return json({ message: "OK" });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();
  return json({ received: true });
};
`,
  },

  remix: {
    name: "Remix",
    routeDir: "app/routes",
    routeFile: "route.tsx", // Remix v2 flat routes
    apiDir: "app/routes/api",
    apiFile: "route.ts",
    layoutFile: "root.tsx",
    componentDir: "app/components",
    libDir: "app/lib",
    configFiles: ["remix.config.js", "vite.config.ts"],
    packageManager: "npm",
    buildCommand: "remix build",
    devCommand: "remix dev",
    routeTemplate: (routePath, componentName) => `export default function ${componentName}() {
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-2xl font-bold">${componentName}</h1>
    </main>
  );
}
`,
    apiTemplate: (routePath) => `import { json } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";

export async function loader({ request }: LoaderFunctionArgs) {
  return json({ message: "OK" });
}

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.json();
  return json({ received: true });
}
`,
  },

  astro: {
    name: "Astro",
    routeDir: "src/pages",
    routeFile: "index.astro",
    apiDir: "src/pages/api",
    apiFile: "index.ts",
    layoutFile: "src/layouts/Layout.astro",
    componentDir: "src/components",
    libDir: "src/lib",
    configFiles: ["astro.config.mjs", "astro.config.ts"],
    packageManager: "npm",
    buildCommand: "astro build",
    devCommand: "astro dev",
    routeTemplate: (routePath, componentName) => `---
// ${componentName} page
---

<html lang="en">
  <body>
    <main class="min-h-screen p-8">
      <h1 class="text-2xl font-bold">${componentName}</h1>
    </main>
  </body>
</html>
`,
  },
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Auto-detect which stack a project uses by checking for config files.
 */
function detectStack(projectRoot) {
  const root = projectRoot || ROOT;

  for (const [stackId, stack] of Object.entries(STACKS)) {
    for (const configFile of (stack.configFiles || [])) {
      if (fs.existsSync(path.join(root, configFile))) {
        return stackId;
      }
    }
  }

  // Check persona-engine.json
  const configPath = path.join(root, "persona-engine.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.stack) { return config.stack; }
    } catch { /* ignore */ }
  }

  return "nextjs"; // Default fallback
}

/**
 * Detect package manager from lock files.
 */
function detectPackageManager(projectRoot) {
  const root = projectRoot || ROOT;
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) { return "bun"; }
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) { return "pnpm"; }
  if (fs.existsSync(path.join(root, "yarn.lock"))) { return "yarn"; }
  return "npm";
}

// ---------------------------------------------------------------------------
// StackAdapter class
// ---------------------------------------------------------------------------

class StackAdapter {
  constructor(projectRoot) {
    this.root = projectRoot || ROOT;
    this.stackId = detectStack(this.root);
    this.stack = STACKS[this.stackId] || STACKS.nextjs;
    this.packageManager = detectPackageManager(this.root);

    // Allow overrides from persona-engine.json
    const configPath = path.join(this.root, "persona-engine.json");
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (config.paths) {
          if (config.paths.routeDir) { this.stack.routeDir = config.paths.routeDir; }
          if (config.paths.apiDir) { this.stack.apiDir = config.paths.apiDir; }
          if (config.paths.componentDir) { this.stack.componentDir = config.paths.componentDir; }
          if (config.paths.libDir) { this.stack.libDir = config.paths.libDir; }
        }
      } catch { /* ignore */ }
    }
  }

  /**
   * Convert a URL route to the source file path.
   * e.g., "/dashboard" → "app/dashboard/page.tsx" (Next.js)
   * e.g., "/dashboard" → "src/routes/dashboard/+page.svelte" (SvelteKit)
   */
  routeToSourceFile(route) {
    const clean = route.replace(/^\//, "").replace(/\/$/, "") || "";
    const routeDir = this.stack.routeDir;
    const routeFile = this.stack.routeFile;

    if (clean === "") {
      return path.join(routeDir, routeFile);
    }
    return path.join(routeDir, clean, routeFile);
  }

  /**
   * Convert a URL route to the API file path.
   * e.g., "/api/users" → "app/api/users/route.ts" (Next.js)
   */
  routeToApiFile(route) {
    const clean = route.replace(/^\/api\//, "").replace(/^\//, "").replace(/\/$/, "");
    const apiDir = this.stack.apiDir;
    const apiFile = this.stack.apiFile;
    return path.join(apiDir, clean, apiFile);
  }

  /**
   * Get the route template for a given route.
   */
  getRouteTemplate(route) {
    const componentName = this._routeToComponentName(route);
    if (this.stack.routeTemplate) {
      return this.stack.routeTemplate(route, componentName);
    }
    return `// ${componentName} page\n`;
  }

  /**
   * Get the API template for a given route.
   */
  getApiTemplate(route) {
    if (this.stack.apiTemplate) {
      return this.stack.apiTemplate(route);
    }
    return `// API handler for ${route}\n`;
  }

  /**
   * Get the build command for this stack.
   */
  getBuildCommand() {
    const pm = this.packageManager;
    const cmd = this.stack.buildCommand;
    if (pm === "npm") { return `npx ${cmd}`; }
    if (pm === "pnpm") { return `pnpm exec ${cmd}`; }
    if (pm === "bun") { return `bun run ${cmd}`; }
    if (pm === "yarn") { return `yarn ${cmd}`; }
    return cmd;
  }

  /**
   * Get the dev command for this stack.
   */
  getDevCommand() {
    const pm = this.packageManager;
    const cmd = this.stack.devCommand;
    if (pm === "npm") { return `npx ${cmd}`; }
    if (pm === "pnpm") { return `pnpm exec ${cmd}`; }
    if (pm === "bun") { return `bun run ${cmd}`; }
    if (pm === "yarn") { return `yarn ${cmd}`; }
    return cmd;
  }

  /**
   * Get the install command for this stack.
   */
  getInstallCommand() {
    const pm = this.packageManager;
    if (pm === "bun") { return "bun install"; }
    if (pm === "pnpm") { return "pnpm install"; }
    if (pm === "yarn") { return "yarn install"; }
    return "npm install";
  }

  /**
   * Generate a fix prompt context string for the LLM.
   * Tells the fix engine about this project's framework conventions.
   */
  getFixPromptContext() {
    return `## Project Framework
- Stack: ${this.stack.name}
- Route directory: ${this.stack.routeDir}/
- Route file: ${this.stack.routeFile}
- API directory: ${this.stack.apiDir}/
- API file: ${this.stack.apiFile}
- Components: ${this.stack.componentDir}/
- Lib/utils: ${this.stack.libDir}/
- Package manager: ${this.packageManager}

When creating or modifying files, use the correct framework conventions:
- Route pages go in \`${this.stack.routeDir}/[route]/${this.stack.routeFile}\`
- API handlers go in \`${this.stack.apiDir}/[route]/${this.stack.apiFile}\`
- Shared components go in \`${this.stack.componentDir}/\`
`;
  }

  /**
   * List all routes discovered in the project.
   */
  discoverRoutes() {
    const routeDir = path.join(this.root, this.stack.routeDir);
    if (!fs.existsSync(routeDir)) { return {}; }

    const routes = {};
    const routeFile = this.stack.routeFile;

    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") { continue; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip Next.js special dirs
          if (entry.name.startsWith("_") || entry.name.startsWith("(")) { continue; }
          walk(fullPath, `${prefix}/${entry.name}`);
        } else if (entry.name === routeFile || entry.name === this.stack.apiFile) {
          const route = prefix || "/";
          routes[route] = path.relative(this.root, fullPath).replace(/\\/g, "/");
        }
      }
    };

    walk(routeDir, "");
    return routes;
  }

  /**
   * Get stack metadata for serialization.
   */
  toJSON() {
    return {
      stackId: this.stackId,
      name: this.stack.name,
      routeDir: this.stack.routeDir,
      apiDir: this.stack.apiDir,
      componentDir: this.stack.componentDir,
      libDir: this.stack.libDir,
      packageManager: this.packageManager,
    };
  }

  // Private
  _routeToComponentName(route) {
    const clean = route.replace(/^\//, "").replace(/\/$/, "") || "Home";
    return clean
      .split(/[/-]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join("");
  }
}

module.exports = { StackAdapter, detectStack, detectPackageManager, STACKS };
