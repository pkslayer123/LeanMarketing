import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabaseServer";
import {
  fetchNetworkProjects,
  syncProjectsToLocal,
  getCachedNetworkStatus,
  cacheNetworkStatus,
} from "@/lib/daemon-network";

/**
 * GET /api/daemon-network/sync
 * Returns current daemon network status (cached or fresh).
 */
export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Try cache first
    const cached = await getCachedNetworkStatus();
    if (cached) {
      return NextResponse.json({
        ok: true,
        nodes: cached,
        cached: true,
      });
    }

    // Fetch fresh
    const nodes = await fetchNetworkProjects();
    await cacheNetworkStatus(nodes);

    return NextResponse.json({
      ok: true,
      nodes,
      cached: false,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to fetch network status",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/daemon-network/sync
 * Trigger a full network sync: fetch nodes and upsert into projects table.
 */
export async function POST() {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const nodes = await fetchNetworkProjects();
    await cacheNetworkStatus(nodes);

    const result = await syncProjectsToLocal(nodes, user.id);

    return NextResponse.json({
      ok: true,
      synced: result.synced,
      skipped: result.skipped,
      errors: result.errors,
      nodeCount: nodes.length,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to sync network",
      },
      { status: 500 }
    );
  }
}
