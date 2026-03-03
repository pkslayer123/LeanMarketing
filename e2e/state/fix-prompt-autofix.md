You are improving a Next.js/TypeScript SaaS application based on findings from automated quality testing.

**Fix effectiveness:** resolution rate 0%, trend: stable. Prefer minimal, targeted changes.


## Task: Fix a bug reported by quality testing (MOC build-layer_1_idea_definition-1772555869139)
**Title:** Build feature: Layer 1 — Idea Definition
**Page:** /api/ideas
**Source files:** app\api\ideas\route.ts
**Change type:** bug_fix


**Findings:**


## Your Task
1. Read the source file(s) listed above to understand the current code.
2. Understand what the findings are asking for — these may be bugs, UX improvements, accessibility issues, security fixes, or product quality suggestions.
3. If this is a real bug, fix the root cause. If it's truly just noise (transient network errors, loading states that resolve on their own), explain why. But if there's a real issue, fix it.
4. If every finding is truly just noise (transient network errors, empty loading states, features already working correctly), explain why no changes are needed. But if the findings describe a real improvement opportunity, implement it.
5. Make your changes using the Edit tool. Follow CLAUDE.md conventions (dark mode, null safety, etc.).
6. After making changes, verify they pass type-check: run `npx tsc --noEmit --pretty false 2>&1 | grep "error TS" | head -5`
7. If type-check shows new errors in your modified file, fix them.

## Rules
- Only modify application code (app/, lib/, components/). NEVER touch e2e/, __tests__/, supabase/, or middleware.ts.
- Keep changes minimal and focused on what the findings describe.
- Do NOT refactor surrounding code or add comments/docs beyond what's needed.
- Do NOT replace error messages with finding descriptions.
- Every bg-white needs dark:bg-gray-800, every text-gray-900 needs dark:text-gray-100 (see CLAUDE.md).
- Use `?.` and `?? fallback` for null safety (strict mode: noUncheckedIndexedAccess).
