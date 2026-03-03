-- Conversation stage enum: tracks where a lead is in the qualification pipeline
create type conversation_stage as enum (
  'not_relevant',
  'curious',
  'interested',
  'ready_to_evaluate'
);

-- Message direction enum
create type message_direction as enum ('outbound', 'inbound');

-- One conversation per lead; tracks stage, quality gate, and suggested next action
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  lead_id uuid references leads(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  stage conversation_stage not null default 'curious',
  next_action text,
  quality_gate_passed boolean not null default false,
  quality_gate_feedback jsonb,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(lead_id)
);

alter table conversations enable row level security;

create policy "Users can manage their own conversations"
  on conversations for all
  using (auth.uid() = user_id);

-- Full exchange history per lead
create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  direction message_direction not null,
  content text not null,
  classified_stage conversation_stage,
  created_at timestamptz default now() not null
);

alter table conversation_messages enable row level security;

create policy "Users can manage their own conversation_messages"
  on conversation_messages for all
  using (auth.uid() = user_id);
