-- Offers table for Layer 5 — Paid Conversion
create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  template text not null check (template in ('trial', 'early_access', 'pilot')),
  scope text not null,
  duration_days integer not null,
  price_cents integer not null,
  success_definition text not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  sent_to text,
  quality_gate_passed boolean,
  quality_gate_feedback jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table offers enable row level security;

create policy "Users can manage their own offers"
  on offers for all
  using (auth.uid() = user_id);
