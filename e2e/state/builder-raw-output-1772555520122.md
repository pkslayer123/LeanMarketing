All the required code already exists and is fully implemented:

- **`app/dashboard/page.tsx`** — Server component that fetches user projects from Supabase and renders a grid of project cards, with auth guard redirecting to `/auth/login`
- **`app/api/projects/route.ts`** — GET (list user's projects) and POST (create project) handlers, both scoped to `user_id` for isolation
- **`lib/projects/index.ts`** — `Project` interface + `formatRelativeTime()` utility
- **`components/Dashboard/ProjectCard.tsx`** — Card with project name, status badge (active/paused/converged), and last activity time
- **`components/Dashboard/Sidebar.tsx`** — Sidebar nav with Dashboard and Settings links, active-link highlighting

All the gaps from the spec are satisfied:

| Gap | Status |
|-----|--------|
| `/dashboard` — list all projects with status | Done — grid of `ProjectCard` components |
| Detect persona-engine projects | Done — queries `projects` table per user |
| Show name, status, last activity | Done — `ProjectCard` shows all three |
| Sidebar/header nav | Done — `Sidebar` with Dashboard + Settings nav |
| Project isolation | Done — all queries filter by `user_id` |

No changes needed — the feature is complete.
