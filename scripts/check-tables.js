require("dotenv").config({ path: require("path").join(__dirname, "..", ".env.local") });
const { createClient } = require("@supabase/supabase-js");

const c = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const tables = [
  "projects", "ideas", "leads", "outreach_messages", "conversations",
  "proof_items", "offers", "analytics_events", "project_settings",
  "user_profiles"
];

(async () => {
  for (const t of tables) {
    const { data, error } = await c.from(t).select("id").limit(1);
    if (error) console.log(`  ${t}: MISSING (${error.message})`);
    else console.log(`  ${t}: EXISTS (${data.length} rows)`);
  }
  process.exit(0);
})();
