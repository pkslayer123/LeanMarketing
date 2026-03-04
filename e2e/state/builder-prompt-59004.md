You are building a feature for a production Next.js application called "LeanMarketing".
This is an AI-assisted marketing governance tool for lean startups. It manages marketing campaigns
across a 6-layer validation funnel: Idea → Audience → Conversations → Conversion → Proof → Review.

## YOUR TASK: Build/Improve "Database Schema"

**codeAreas:** `lib/database/`, `supabase/migrations/`

| Aspect | Current | Gap |
|--------|---------|-----|
| Projects table | None | id, name, owner_id, created_at, status |
| Ideas table | None | project_id, description, audience, problem, payment_assumption, next_step |
| Leads table | None | project_id, name, email, company, fit_reason, status, stage |
| Messages table | None | project_id, lead_id, template_version, sent_at, content |
| Conversations table | None | lead_id, direction, content, classification, created_at |
| Offers table | None | project_id, lead_id, scope, duration, price, success_definition, status |
| Analytics table | None | project_id, cycle, messages_sent, replies, stage_advances, bottleneck |
| RLS policies | None | Row-level security per user/project |

## Files That Need Rewriting (too thin — currently stubs)
These files exist but are incomplete stubs. REWRITE them with full, production-quality implementations:

### supabase/migrations/20260304000000_daemon_network_fields.sql (17 lines — needs full rewrite)
```
-- Add daemon network fields to projects table
-- Allows the dashboard to detect and display persona-engine projects from the daemon network

alter table projects
  add column if not exists daemon_project_name text,
  add column if not exists daemon_node_id text,
  add column if not exists is_network_project boolean default false,
  add column if not exists daemon_status text default 'unknown',
  add column if not exists daemon_convergence_score real default 0,
  add column if not exists last_sy
```

## Already Complete (reference only — do not recreate)
- lib/database/index.ts (276 lines)
- lib/database/queries.ts (201 lines)
- supabase/migrations/20260303000000_create_projects_and_ideas.sql (37 lines)
- supabase/migrations/20260303000001_create_audience_and_outreach.sql (114 lines)
- supabase/migrations/20260303000002_create_conversations.sql (49 lines)
- supabase/migrations/20260303000003_create_proof.sql (48 lines)
- supabase/migrations/20260303000004_create_paid_conversion.sql (65 lines)
- supabase/migrations/20260303000005_create_analytics.sql (84 lines)
- supabase/migrations/20260303000006_create_project_settings.sql (51 lines)
- supabase/migrations/20260303000007_add_project_status.sql (158 lines)
- supabase/migrations/20260303000008_add_updated_at_trigger.sql (140 lines)
- supabase/migrations/20260303000009_fill_schema_gaps.sql (60 lines)
- supabase/migrations/20260303000010_add_enums_and_indexes.sql (45 lines)
- supabase/migrations/20260303000011_add_missing_tables.sql (56 lines)

## Specification Requirements (from BUILD-SPEC)
The spec says these aspects need implementation:
- id, name, owner_id, created_at, status
- project_id, description, audience, problem, payment_assumption, next_step
- project_id, name, email, company, fit_reason, status, stage
- project_id, lead_id, template_version, sent_at, content
- lead_id, direction, content, classification, created_at
- project_id, lead_id, scope, duration, price, success_definition, status
- project_id, cycle, messages_sent, replies, stage_advances, bottleneck
- Row-level security per user/project

## Expected Routes
- Determine appropriate routes from the feature description

## CRITICAL INSTRUCTIONS
1. You MUST create or edit files. Do not just describe what should be done — actually write the code.
2. If a file is listed under "Files to Create" — create it with a full implementation.
3. If a file is listed under "Files That Need Rewriting" — rewrite it completely with production-quality code.
4. Every component must be fully functional with real data fetching, forms, and error handling.
5. You MUST write at least 50 lines per page component and 30 lines per utility/lib file.

## Tech Stack
- Next.js App Router with TypeScript (use .tsx for components, .ts for utilities)
- Tailwind CSS for ALL styling (no CSS files)
- Supabase for database and auth (use `@supabase/ssr` createBrowserClient/createServerClient)
- React Server Components by default; add "use client" only when needed (hooks, interactivity)
- API routes: app/api/.../route.ts with GET/POST/PATCH/DELETE exports

## Design Requirements (MANDATORY)
- Navigation: Import the sidebar from components/Dashboard/Sidebar.tsx or create it if missing.
  It must show "LeanMarketing" branding and links to Dashboard, Settings, plus a logout button.
- Color scheme: indigo-600 primary, gray-50 page backgrounds, white cards with border and shadow-sm.
- Layout: max-w-4xl mx-auto with p-6 padding. Use flex layouts with the sidebar.
- Cards: rounded-lg border border-gray-200 p-6 shadow-sm bg-white dark:bg-gray-800
- Forms: labeled inputs with focus:ring-indigo-500, error states in red, success in green.
- Typography: text-2xl font-bold for page titles, text-sm for labels, text-gray-500 for hints.
- Empty states: centered text with a helpful message and an action button.
- Responsive: grid-cols-1 md:grid-cols-2 lg:grid-cols-3 for card grids.
- Dark mode: include dark: variants for all colors.
- This MUST look like a professional SaaS product. No unstyled HTML. No placeholder text.

## File Conventions
- app/[route]/page.tsx — Server component that fetches data and renders the page
- app/api/[route]/route.ts — API handler with proper error responses
- components/[Feature]/index.tsx — Client component with "use client" directive
- lib/[feature].ts — Pure types, validators, helpers (no React)
