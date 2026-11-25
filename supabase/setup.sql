-- DayMate database schema. Safe to run more than once.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null default 'task' check (kind in ('task','event')),
  title text not null check (char_length(title) <= 300),
  notes text not null default '' check (char_length(notes) <= 4000),
  date date,
  time time,
  end_time time,
  priority text not null default 'normal' check (priority in ('high','normal','low')),
  done boolean not null default false,
  link text not null default '',
  remind_minutes int,
  remind_at timestamptz,
  notified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists items_user_date on public.items (user_id, date);
create index if not exists items_due_reminders on public.items (remind_at) where notified = false and done = false;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default current_date,
  calls int not null default 0,
  primary key (user_id, day)
);

-- Server-only settings (push keys). No policies = only server functions can read it.
create table if not exists public.app_config (
  key text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

alter table public.items enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists "own items" on public.items;
create policy "own items" on public.items for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own subscriptions" on public.push_subscriptions;
create policy "own subscriptions" on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "read own usage" on public.ai_usage;
create policy "read own usage" on public.ai_usage for select using (user_id = auth.uid());

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();

-- Live sync to all of a user's devices
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- Table access for the API (security rules above still apply to users)
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on public.items, public.push_subscriptions to authenticated;
grant select on public.ai_usage to authenticated;

-- Run the reminder sender every minute
select cron.unschedule(jobid) from cron.job where jobname = 'daymate-reminders';
select cron.schedule('daymate-reminders', '* * * * *', $job$
  select net.http_post(
    url := 'https://jqstbcikdezgrtuuarse.supabase.co/functions/v1/reminders',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb);
$job$);
