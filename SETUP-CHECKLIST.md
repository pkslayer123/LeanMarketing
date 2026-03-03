# Setup Checklist — LeanMarketing

## Prerequisites

- [ ] Node.js 18+ installed (`node --version`)
- [ ] npm installed (`npm --version`)
- [ ] GitHub CLI authenticated (`gh auth status`)
- [ ] Playwright browsers installed (`npx playwright install chromium`)

## Environment Variables

Copy these to your `.env.local` (they should already be there if you used `persona-engine new-project`):

- [ ] `NEXT_PUBLIC_SUPABASE_URL` — Your Supabase project URL
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (secret)
- [ ] `GEMINI_API_KEY` — For oracle validation
- [ ] `CHANGEPILOT_SERVICE_KEY` — For network sync (optional)

## Verify Setup

```bash
# Install dependencies
npm install

# Type check
npm run type-check

# Build
npm run build

# Run smoke test
cd e2e && npx playwright test tests/00-smoke.spec.ts

# Start daemon
npx persona-engine start
npx persona-engine status
```

## For Your Partner

If setting up on a second machine:
1. Clone the repo: `gh repo clone LeanMarketing`
2. Copy `.env.local` from the primary machine (contains all tokens)
3. Run `npm install`
4. Run `npx playwright install chromium`
5. Start the daemon: `npx persona-engine start`

The daemon will auto-detect the network and begin coordinating with other running daemons.
