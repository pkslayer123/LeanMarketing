#!/usr/bin/env node

/**
 * ACO Path Selector — Ant Colony Optimization for test path sequences.
 *
 * Models the app as a directed graph where nodes are pages/states and edges
 * are user actions. Personas construct test sessions by walking the graph
 * with pheromone-guided probability. Discovers productive ACTION SEQUENCES,
 * not just hotspot locations.
 *
 * Reads:
 *   - e2e/state/hotspot-map.json (node pheromones)
 *   - e2e/state/findings/findings.json
 *   - e2e/state/green-history.json
 *   - e2e/state/manifest.json
 *   - e2e/state/aco-graph.json (previous state)
 *
 * Writes:
 *   - e2e/state/aco-graph.json
 *
 * Usage:
 *   node scripts/e2e/aco-path-selector.js              # Summary report
 *   node scripts/e2e/aco-path-selector.js --json        # Machine-readable output
 *   node scripts/e2e/aco-path-selector.js --export      # Write to aco-graph.json
 *   node scripts/e2e/aco-path-selector.js --persona <id> # Show suggested path for one persona
 *   node scripts/e2e/aco-path-selector.js --top 10      # Top N strongest edges
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const HOTSPOT_PATH = path.join(ROOT, "e2e", "state", "hotspot-map.json");
const FINDINGS_PATH = path.join(ROOT, "e2e", "state", "findings", "findings.json");
const GREEN_HISTORY_PATH = path.join(ROOT, "e2e", "state", "green-history.json");
const MANIFEST_PATH = path.join(ROOT, "e2e", "state", "manifest.json");
const ACO_GRAPH_PATH = path.join(ROOT, "e2e", "state", "aco-graph.json");

const args = process.argv.slice(2);
const isJson = args.includes("--json");
const doExport = args.includes("--export");
const personaDrill = getArg("--persona");
const topN = parseInt(getArg("--top") ?? "10", 10);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function padRight(str, len) {
  return String(str).padEnd(len);
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  alpha: 1.0,              // pheromone influence
  beta: 2.0,               // heuristic (novelty) influence
  evaporation_rate: 0.1,   // per-iteration evaporation
  deposit_base: 0.1,       // base pheromone deposit per traversal
  deposit_finding_multiplier: 5.0, // extra deposit per finding on edge
  min_pheromone: 0.01,
  max_pheromone: 10.0,
};

const DEFAULT_PATH_LENGTH = 5; // nodes per suggested path

// ---------------------------------------------------------------------------
// Canonical app pages extracted from manifest + common routes
// ---------------------------------------------------------------------------

const WELL_KNOWN_PAGES = [
  "/mocs",
  "/mocs/new",
  "/moc/:id/overview",
  "/moc/:id/stage-0",
  "/moc/:id/stage-1",
  "/moc/:id/stage-2",
  "/moc/:id/stage-3",
  "/moc/:id/stage-4",
  "/moc/:id/stage-5",
  "/moc/:id/stage-6",
  "/review/role-inbox",
  "/my-department",
  "/admin",
  "/admin/people",
  "/admin/departments",
  "/admin/permissions",
  "/admin/features",
  "/admin/settings",
  "/admin/analytics",
  "/admin/developer",
  "/admin/developer/permissions",
  "/admin/errors",
  "/admin/audit",
  "/account",
  "/account/settings",
];

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function extractPagesFromManifest(manifest) {
  const pages = new Set(WELL_KNOWN_PAGES);
  if (manifest && manifest.features) {
    for (const config of Object.values(manifest.features)) {
      for (const p of config.pages ?? []) {
        pages.add(p);
      }
    }
  }
  return [...pages];
}

function extractPersonasFromManifest(manifest) {
  const personaSet = new Set();
  if (manifest && manifest.features) {
    for (const config of Object.values(manifest.features)) {
      for (const p of config.personas ?? []) {
        personaSet.add(p);
      }
    }
  }
  return [...personaSet];
}

function normalizePageFromUrl(url) {
  if (!url) {
    return null;
  }
  // Collapse UUIDs and numeric IDs into :id
  let normalized = url
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:id");
  // Remove query strings and trailing slashes
  normalized = normalized.split("?")[0].replace(/\/$/, "") || "/";
  return normalized;
}

function buildGraph(manifest, findings, greenHistory, previousGraph) {
  const pages = extractPagesFromManifest(manifest);
  const config = previousGraph?.config ?? { ...DEFAULT_CONFIG };

  // Initialize nodes from pages
  const nodes = {};
  for (const page of pages) {
    const prev = previousGraph?.nodes?.[page];
    nodes[page] = {
      visit_count: prev?.visit_count ?? 0,
      last_finding_iteration: prev?.last_finding_iteration ?? 0,
    };
  }

  // Initialize edges from previous state
  const edges = {};
  if (previousGraph?.edges) {
    for (const [key, edge] of Object.entries(previousGraph.edges)) {
      edges[key] = { ...edge };
    }
  }

  // Build adjacency from well-known page transitions
  // Natural stage flow
  const stageTransitions = [];
  for (let i = 0; i < 6; i++) {
    stageTransitions.push([`/moc/:id/stage-${i}`, `/moc/:id/stage-${i + 1}`]);
  }
  // Common navigations
  const commonTransitions = [
    ["/mocs", "/mocs/new"],
    ["/mocs", "/moc/:id/overview"],
    ["/moc/:id/overview", "/moc/:id/stage-0"],
    ["/mocs/new", "/moc/:id/stage-0"],
    ["/moc/:id/stage-3", "/review/role-inbox"],
    ["/review/role-inbox", "/moc/:id/stage-4"],
    ["/admin", "/admin/people"],
    ["/admin", "/admin/departments"],
    ["/admin", "/admin/permissions"],
    ["/admin", "/admin/features"],
    ["/admin", "/admin/settings"],
    ["/admin", "/admin/developer"],
    ["/admin/developer", "/admin/developer/permissions"],
    ["/mocs", "/admin"],
    ["/admin", "/mocs"],
    ["/mocs", "/my-department"],
    ["/my-department", "/review/role-inbox"],
    ["/mocs", "/account"],
  ];

  const allTransitions = [...stageTransitions, ...commonTransitions];
  for (const [from, to] of allTransitions) {
    const edgeKey = `${from}->${to}`;
    if (!edges[edgeKey]) {
      edges[edgeKey] = {
        pheromone: 1.0, // initial pheromone
        traversal_count: 0,
        findings_on_path: 0,
        avg_path_severity: 0,
        last_traversed: 0,
      };
    }
  }

  // --- Step 1: Evaporate ---
  for (const edge of Object.values(edges)) {
    edge.pheromone *= (1 - config.evaporation_rate);
  }

  // --- Step 2: Deposit from findings ---
  const allFindings = Array.isArray(findings)
    ? findings
    : findings?.findings ?? [];

  // Compute current iteration estimate from findings timestamps
  const currentIteration = previousGraph?.meta?.current_iteration
    ? previousGraph.meta.current_iteration + 1
    : 1;

  const severityMap = { security: 5, bug: 4, ux: 2, suggestion: 1 };

  // For each open finding, trace the page and deposit on edges leading to it
  const openFindings = allFindings.filter((f) => f.status !== "resolved");
  for (const finding of openFindings) {
    const page = normalizePageFromUrl(finding.page);
    if (!page) {
      continue;
    }

    // Update node
    if (nodes[page]) {
      nodes[page].visit_count += 1;
      nodes[page].last_finding_iteration = currentIteration;
    } else {
      nodes[page] = {
        visit_count: 1,
        last_finding_iteration: currentIteration,
      };
    }

    const severity = severityMap[finding.severity] ?? 1;

    // Deposit pheromone on all edges that lead TO this page
    for (const [edgeKey, edge] of Object.entries(edges)) {
      const target = edgeKey.split("->")[1];
      if (target === page) {
        edge.pheromone += config.deposit_base * config.deposit_finding_multiplier * severity;
        edge.findings_on_path += 1;
        // Running average severity
        const totalFindings = edge.findings_on_path;
        edge.avg_path_severity =
          ((edge.avg_path_severity * (totalFindings - 1)) + severity) / totalFindings;
        edge.last_traversed = currentIteration;
      }
    }
  }

  // --- Step 3: Deposit from green history (negative — well-tested paths get less) ---
  // Pages with many consecutive passes get slight evaporation boost
  if (greenHistory?.tests) {
    for (const [testTitle, testData] of Object.entries(greenHistory.tests)) {
      if ((testData.consecutivePasses ?? 0) >= 10) {
        // Find matching pages in edges and slightly reduce pheromone
        for (const page of pages) {
          const pageSuffix = page.replace(/\/:id/g, "").replace(/\//g, " ").trim();
          if (pageSuffix && testTitle.toLowerCase().includes(pageSuffix.toLowerCase())) {
            for (const [edgeKey, edge] of Object.entries(edges)) {
              if (edgeKey.includes(page)) {
                edge.pheromone *= 0.95; // slight reduction for well-tested paths
              }
            }
          }
        }
      }
    }
  }

  // --- Step 4: Clamp pheromones ---
  for (const edge of Object.values(edges)) {
    edge.pheromone = Math.max(config.min_pheromone, Math.min(config.max_pheromone, edge.pheromone));
    edge.pheromone = parseFloat(edge.pheromone.toFixed(4));
  }

  return { nodes, edges, config, currentIteration };
}

// ---------------------------------------------------------------------------
// Path suggestion via probabilistic walk
// ---------------------------------------------------------------------------

function getNeighbors(node, edges) {
  const neighbors = [];
  for (const [edgeKey, edge] of Object.entries(edges)) {
    const parts = edgeKey.split("->");
    if (parts[0] === node && parts[1]) {
      neighbors.push({ target: parts[1], edge, edgeKey });
    }
  }
  return neighbors;
}

function suggestPathForPersona(personaId, nodes, edges, config, manifest, pathLength) {
  // Determine start page based on persona's manifest assignment
  let startPage = "/mocs"; // default
  if (manifest?.features) {
    for (const featureConfig of Object.values(manifest.features)) {
      if ((featureConfig.personas ?? []).includes(personaId)) {
        const pages = featureConfig.pages ?? [];
        if (pages.length > 0) {
          startPage = pages[0];
          break;
        }
      }
    }
  }

  const visited = new Set();
  const pathNodes = [startPage];
  let current = startPage;

  for (let step = 0; step < pathLength - 1; step++) {
    visited.add(current);
    const neighbors = getNeighbors(current, edges).filter(
      (n) => !visited.has(n.target)
    );

    if (neighbors.length === 0) {
      break;
    }

    // Compute probabilities: pheromone^alpha * heuristic^beta
    const probabilities = [];
    let totalProb = 0;

    for (const neighbor of neighbors) {
      const pheromone = Math.pow(neighbor.edge.pheromone, config.alpha);
      // Heuristic = inverse visit count (novelty)
      const visitCount = nodes[neighbor.target]?.visit_count ?? 0;
      const heuristic = Math.pow(1.0 / (1 + visitCount), config.beta);
      const prob = pheromone * heuristic;
      probabilities.push(prob);
      totalProb += prob;
    }

    if (totalProb === 0) {
      break;
    }

    // Roulette wheel selection
    const rand = Math.random() * totalProb;
    let cumulative = 0;
    let selectedIdx = 0;
    for (let i = 0; i < probabilities.length; i++) {
      cumulative += probabilities[i];
      if (cumulative >= rand) {
        selectedIdx = i;
        break;
      }
    }

    const selected = neighbors[selectedIdx];
    pathNodes.push(selected.target);

    // Record traversal
    selected.edge.traversal_count += 1;
    selected.edge.last_traversed = 0; // will be set to currentIteration in caller

    current = selected.target;
  }

  return pathNodes;
}

function suggestAllPaths(nodes, edges, config, manifest) {
  const personas = extractPersonasFromManifest(manifest);
  const suggestedPaths = {};

  for (const personaId of personas) {
    suggestedPaths[personaId] = suggestPathForPersona(
      personaId,
      nodes,
      edges,
      config,
      manifest,
      DEFAULT_PATH_LENGTH
    );
  }

  return suggestedPaths;
}

// ---------------------------------------------------------------------------
// Meta statistics
// ---------------------------------------------------------------------------

function computeMeta(nodes, edges, currentIteration) {
  const edgeEntries = Object.entries(edges);
  const totalPheromone = edgeEntries.reduce((sum, [, e]) => sum + e.pheromone, 0);
  const avgPheromone = edgeEntries.length > 0
    ? parseFloat((totalPheromone / edgeEntries.length).toFixed(4))
    : 0;

  // Find strongest edge
  let strongestPath = null;
  let strongestPheromone = 0;
  for (const [key, edge] of edgeEntries) {
    if (edge.pheromone > strongestPheromone) {
      strongestPheromone = edge.pheromone;
      strongestPath = key;
    }
  }

  return {
    total_nodes: Object.keys(nodes).length,
    total_edges: edgeEntries.length,
    avg_pheromone: avgPheromone,
    strongest_path: strongestPath,
    strongest_pheromone: parseFloat(strongestPheromone.toFixed(4)),
    current_iteration: currentIteration,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(graphState) {
  const { nodes, edges, suggested_paths, meta } = graphState;

  console.log("");
  console.log("ACO Path Selector");
  console.log("==================");
  console.log(
    `Nodes: ${meta.total_nodes} | Edges: ${meta.total_edges} | ` +
    `Avg pheromone: ${meta.avg_pheromone} | Iteration: ${meta.current_iteration}`
  );
  console.log(`Strongest path: ${meta.strongest_path ?? "(none)"} (${meta.strongest_pheromone})`);
  console.log("");

  // Top N edges by pheromone
  const sortedEdges = Object.entries(edges)
    .sort(([, a], [, b]) => b.pheromone - a.pheromone)
    .slice(0, topN);

  console.log(`Top ${topN} edges by pheromone:`);
  console.log(
    padRight("Edge", 50) +
    padRight("Pheromone", 12) +
    padRight("Traversals", 12) +
    padRight("Findings", 10) +
    padRight("Avg Sev", 10)
  );
  console.log("-".repeat(94));

  for (const [key, edge] of sortedEdges) {
    console.log(
      padRight(key, 50) +
      padRight(edge.pheromone.toFixed(4), 12) +
      padRight(edge.traversal_count, 12) +
      padRight(edge.findings_on_path, 10) +
      padRight(edge.avg_path_severity.toFixed(1), 10)
    );
  }
  console.log("");

  // Persona path suggestions (sample)
  const personaIds = Object.keys(suggested_paths).slice(0, 8);
  if (personaIds.length > 0) {
    console.log("Suggested paths (sample):");
    for (const pid of personaIds) {
      const pathStr = suggested_paths[pid].join(" -> ");
      console.log(`  ${padRight(pid, 22)} ${pathStr}`);
    }
    console.log(`  ... (${Object.keys(suggested_paths).length} total personas)`);
    console.log("");
  }
}

function printPersonaPath(graphState, personaId) {
  const pathNodes = graphState.suggested_paths[personaId];

  console.log("");
  console.log(`ACO Path for: ${personaId}`);
  console.log("=".repeat(50));

  if (!pathNodes || pathNodes.length === 0) {
    console.log("No path suggested. Persona may not be in the manifest.");
    return;
  }

  console.log(`Path: ${pathNodes.join(" -> ")}`);
  console.log("");

  // Show edges along the path
  console.log("Edge details:");
  for (let i = 0; i < pathNodes.length - 1; i++) {
    const edgeKey = `${pathNodes[i]}->${pathNodes[i + 1]}`;
    const edge = graphState.edges[edgeKey];
    if (edge) {
      console.log(
        `  ${edgeKey}` +
        ` | pheromone: ${edge.pheromone.toFixed(4)}` +
        ` | findings: ${edge.findings_on_path}` +
        ` | traversals: ${edge.traversal_count}`
      );
    } else {
      console.log(`  ${edgeKey} | (new edge)`);
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const manifest = loadJson(MANIFEST_PATH);
  if (!manifest || !manifest.features) {
    console.error("[aco] Manifest not found. Run: node scripts/e2e/sync-manifest.js");
    process.exit(1);
  }

  const findings = loadJson(FINDINGS_PATH) ?? [];
  const greenHistory = loadJson(GREEN_HISTORY_PATH) ?? { tests: {} };
  const previousGraph = loadJson(ACO_GRAPH_PATH);

  // Build/update graph
  const { nodes, edges, config, currentIteration } = buildGraph(
    manifest,
    findings,
    greenHistory,
    previousGraph
  );

  // Suggest paths
  const suggested_paths = suggestAllPaths(nodes, edges, config, manifest);

  // Compute meta
  const meta = computeMeta(nodes, edges, currentIteration);

  const graphState = { nodes, edges, suggested_paths, config, meta };

  // Output
  if (isJson) {
    console.log(JSON.stringify(graphState, null, 2));
  } else if (personaDrill) {
    printPersonaPath(graphState, personaDrill);
  } else {
    printSummary(graphState);
  }

  if (doExport) {
    fs.mkdirSync(path.dirname(ACO_GRAPH_PATH), { recursive: true });
    fs.writeFileSync(ACO_GRAPH_PATH, JSON.stringify(graphState, null, 2) + "\n");
    if (!isJson) {
      console.log(`Exported to ${path.relative(ROOT, ACO_GRAPH_PATH)}`);
    }
  }
}

main();
