# CLAUDE.md — LeanMarketing

## What This Project Is

LeanMarketing is a Next.js application built and maintained by the Persona Engine daemon.
The daemon autonomously builds features from the BUILD-SPEC, tests them with AI personas,
fixes issues, and converges toward production quality.

## Tech Stack

- **Framework:** Next.js (App Router) with React, TypeScript
- **Database:** Supabase (PostgreSQL) with RLS
- **Styling:** Tailwind CSS
- **Auth:** Supabase Auth
- **Testing:** Playwright E2E with persona-driven oracle validation
- **Deployment:** Vercel (auto-deploys from GitHub)

## Project Structure

```
app/             Next.js App Router pages and API routes
components/      Shared UI components
lib/             Utilities, services, hooks
docs/            BUILD-SPEC.md (source of truth for what to build)
e2e/             Persona testing infrastructure
  state/         Daemon state files (findings, MOC queue, convergence)
  tests/         Generated Playwright tests
  oracle/        Oracle prompt templates
scripts/e2e/     Daemon scripts and claw implementations
daemon-config.json  Daemon configuration
persona-engine.json Project configuration
```

## Daemon Architecture

The daemon has 7 claws that run independently:

| Claw | Purpose |
|------|---------|
| test-runner | Runs Playwright persona tests against the deployed app |
| finding-pipeline | Classifies findings, creates MOCs |
| builder | Reads BUILD-SPEC, scaffolds new features via LLM |
| fix-engine | Fixes MOCs using Claude CLI (or Cursor fallback) |
| intelligence | ROI scoring, strategy optimization, learning |
| health-deploy | Health checks, compliance scoring, reports |
| diagnostics | Self-diagnosis, pipeline integrity |

## Commands

```bash
npx persona-engine start       # Start daemon
npx persona-engine status      # Check status
npx persona-engine stop        # Stop daemon
npx persona-engine trigger <claw>  # Trigger a specific claw
```

## Key State Files

- `e2e/state/findings/findings.json` — Accumulated findings from persona tests
- `e2e/state/moc-queue.json` — MOCs awaiting fix
- `e2e/state/spec-compliance-report.json` — Compliance score and build phase
- `e2e/state/builder-state.json` — Builder progress
- `e2e/state/claw-signals.json` — Inter-claw coordination

## Convergence Phases

The daemon progresses through phases based on compliance score:
- **BUILD** (0-0.3): Scaffold features aggressively
- **STABILIZE** (0.3-0.6): Reduce building, increase testing
- **POLISH** (0.6-0.85): Fix UX, accessibility, edge cases
- **CONVERGED** (0.85+): Done. Report and wait for spec changes.

## Network Connection

This project is part of a daemon network coordinated via ChangePilot (https://moc-ai.vercel.app).
Verified learnings (concepts, strategies, convergence configs) are shared across daemons.
Project-specific knowledge (BUILD-SPEC, routes, code patterns) is never shared.

## Environment Variables

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
Network: `CHANGEPILOT_API_URL`, `CHANGEPILOT_SERVICE_KEY`, `CHANGEPILOT_PROJECT_ID`
LLM: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` (optional, for Claude fixes)
