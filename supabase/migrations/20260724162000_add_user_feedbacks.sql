create table if not exists public.user_feedbacks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  integration_id uuid,
  org_target_id uuid,
  source_page text not null,
  current_step text,
  setup_trace_id text,
  task_id text,
  record_id text,
  feedback_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists user_feedbacks_user_id_idx
  on public.user_feedbacks (user_id);

create index if not exists user_feedbacks_integration_id_idx
  on public.user_feedbacks (integration_id);

create index if not exists user_feedbacks_org_target_id_idx
  on public.user_feedbacks (org_target_id);

create index if not exists user_feedbacks_setup_trace_id_idx
  on public.user_feedbacks (setup_trace_id);

create index if not exists user_feedbacks_created_at_idx
  on public.user_feedbacks (created_at);
