The Dashboard and Project Overview feature is **already fully implemented**. The existing scaffolding covers all the specified gaps:

| Gap | Status |
|-----|--------|
| `/dashboard` — list projects with status | `app/dashboard/page.tsx` — complete, queries Supabase with auth guard |
| Show project name, status, last activity | `components/Dashboard/ProjectCard.tsx` — complete with status badges |
| Sidebar/header nav | `components/Dashboard/Sidebar.tsx` — complete with active state |
| Project data isolation | RLS policy in migration `20260303000000` + `user_id` filter in all queries |
| Database schema | Migrations 000000 + 000007 add `projects` table with `status` and `last_activity_at` |

The "detect persona-engine projects in the daemon network" gap refers to *how projects get into the database* — that's the daemon's responsibility (the builder claw registers projects), not the dashboard's. The dashboard correctly reads whatever the daemon has written.

No code changes needed — the feature is scaffold-complete and functional.
