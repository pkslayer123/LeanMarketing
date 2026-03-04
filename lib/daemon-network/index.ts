import { createClient } from "@supabase/supabase-js";

/**
 * Daemon Network Integration
 *
 * Fetches active persona-engine projects from the ChangePilot daemon network
 * and syncs them to the local Supabase projects table.
 *
 * The BUILD-SPEC requires: "recognize existing and new projects in the persona
 * daemon network (excluding itself) and act as a single location to manage
 * autonomous marketing assistance."
 */

export interface DaemonNode {
  projectId: string;
  projectName: string;
  nodeId: string;
  status: string;
  convergenceScore: number;
  lastHeartbeat: string;
  baseUrl?: string;
  stack?: string;
  buildPhase?: string;
  clawCycle?: number;
  mocCount?: number;
}

export interface NetworkSyncResult {
  synced: number;
  skipped: number;
  errors: string[];
  nodes: DaemonNode[];
}

interface HeartbeatResponse {
  ok: boolean;
  nodes?: Array<{
    projectId?: string;
    projectName?: string;
    project_name?: string;
    nodeId?: string;
    node_id?: string;
    status?: string;
    convergenceScore?: number;
    convergence_score?: number;
    lastHeartbeat?: string;
    last_heartbeat?: string;
    baseUrl?: string;
    base_url?: string;
    stack?: string;
  }>;
  error?: string;
}

const SELF_PROJECT_NAME = "LeanMarketing";

function getChangePilotConfig() {
  const url = process.env.CHANGEPILOT_API_URL || "https://moc-ai.vercel.app";
  const key = process.env.CHANGEPILOT_SERVICE_KEY || "";
  return { url, key };
}

/**
 * Fetch active daemon nodes from the ChangePilot network.
 * Excludes the LeanMarketing node itself.
 */
export async function fetchNetworkProjects(): Promise<DaemonNode[]> {
  const { url, key } = getChangePilotConfig();

  if (!key) {
    // Try reading from persona-engine.json
    try {
      const fs = await import("fs");
      const path = await import("path");
      const configPath = path.join(process.cwd(), "persona-engine.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const changepilot = config.changepilot || {};
      if (changepilot.serviceKey) {
        return fetchWithKey(changepilot.url || url, changepilot.serviceKey);
      }
    } catch {
      // Fall through
    }
    return [];
  }

  return fetchWithKey(url, key);
}

async function fetchWithKey(
  apiUrl: string,
  serviceKey: string
): Promise<DaemonNode[]> {
  try {
    const resp = await fetch(`${apiUrl}/api/daemon-network/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        projectName: SELF_PROJECT_NAME,
        action: "list-nodes",
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      console.error(
        `Daemon network heartbeat failed: ${resp.status} ${resp.statusText}`
      );
      return [];
    }

    const data = (await resp.json()) as HeartbeatResponse;
    if (!data.ok || !Array.isArray(data.nodes)) {
      return [];
    }

    return data.nodes
      .map((n) => ({
        projectId: n.projectId || "",
        projectName: n.projectName || n.project_name || "Unknown",
        nodeId: n.nodeId || n.node_id || "",
        status: n.status || "unknown",
        convergenceScore: n.convergenceScore ?? n.convergence_score ?? 0,
        lastHeartbeat: n.lastHeartbeat || n.last_heartbeat || "",
        baseUrl: n.baseUrl || n.base_url,
        stack: n.stack,
      }))
      .filter((n) => n.projectName !== SELF_PROJECT_NAME);
  } catch (err) {
    console.error(
      `Daemon network fetch error: ${err instanceof Error ? err.message : "unknown"}`
    );
    return [];
  }
}

/**
 * Sync network projects to local Supabase projects table.
 * Creates or updates projects with is_network_project=true.
 */
export async function syncProjectsToLocal(
  nodes: DaemonNode[],
  userId: string
): Promise<NetworkSyncResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return { synced: 0, skipped: 0, errors: ["Missing Supabase credentials"], nodes };
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const result: NetworkSyncResult = { synced: 0, skipped: 0, errors: [], nodes };

  for (const node of nodes) {
    try {
      // Check if project already exists by daemon_node_id
      const { data: existing } = await supabase
        .from("projects")
        .select("id, last_synced_at")
        .eq("daemon_node_id", node.nodeId)
        .maybeSingle();

      if (existing) {
        // Update existing network project
        const { error } = await supabase
          .from("projects")
          .update({
            daemon_project_name: node.projectName,
            daemon_status: node.status,
            daemon_convergence_score: node.convergenceScore,
            daemon_build_phase: node.buildPhase ?? null,
            daemon_claw_cycle: node.clawCycle ?? 0,
            daemon_moc_count: node.mocCount ?? 0,
            last_synced_at: new Date().toISOString(),
            status: mapDaemonStatus(node.status),
          })
          .eq("id", existing.id);

        if (error) {
          result.errors.push(`Update ${node.projectName}: ${error.message}`);
        } else {
          result.synced++;
        }
      } else {
        // Insert new network project
        const { error } = await supabase.from("projects").insert({
          user_id: userId,
          name: node.projectName,
          daemon_project_name: node.projectName,
          daemon_node_id: node.nodeId,
          is_network_project: true,
          daemon_status: node.status,
          daemon_convergence_score: node.convergenceScore,
          daemon_build_phase: node.buildPhase ?? null,
          daemon_claw_cycle: node.clawCycle ?? 0,
          daemon_moc_count: node.mocCount ?? 0,
          last_synced_at: new Date().toISOString(),
          status: mapDaemonStatus(node.status),
        });

        if (error) {
          result.errors.push(`Insert ${node.projectName}: ${error.message}`);
        } else {
          result.synced++;
        }
      }
    } catch (err) {
      result.errors.push(
        `${node.projectName}: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
  }

  return result;
}

function mapDaemonStatus(daemonStatus: string): "active" | "paused" | "converged" {
  switch (daemonStatus) {
    case "converged":
      return "converged";
    case "paused":
    case "suspended":
      return "paused";
    default:
      return "active";
  }
}

/**
 * Get cached network status. Returns null if cache is stale (>5 min).
 */
export async function getCachedNetworkStatus(): Promise<DaemonNode[] | null> {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const cachePath = path.join(
      process.cwd(),
      "e2e",
      "state",
      "daemon-network-cache.json"
    );

    if (!fs.existsSync(cachePath)) return null;

    const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    const age = Date.now() - new Date(cache.timestamp).getTime();

    if (age > 5 * 60 * 1000) return null; // Stale
    return cache.nodes || null;
  } catch {
    return null;
  }
}

/**
 * Save network status to cache file.
 */
export async function cacheNetworkStatus(nodes: DaemonNode[]): Promise<void> {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const cachePath = path.join(
      process.cwd(),
      "e2e",
      "state",
      "daemon-network-cache.json"
    );

    fs.writeFileSync(
      cachePath,
      JSON.stringify({ timestamp: new Date().toISOString(), nodes }, null, 2) +
        "\n"
    );
  } catch {
    // Non-fatal
  }
}
