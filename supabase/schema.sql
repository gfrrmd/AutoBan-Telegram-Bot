-- Jalankan seluruh isi file ini di Supabase > SQL Editor > New query > Run

create table if not exists chats (
  chat_id bigint primary key,
  title text,
  type text,
  username text,
  managed boolean not null default false,
  bot_admin boolean not null default true,
  leave_ban boolean not null default true,
  passive_check boolean not null default false,
  passive_since timestamptz,
  deadline_minutes integer not null default 4320,
  tolerance integer not null default 1,
  linked_chat_id bigint,
  created_at timestamptz not null default now()
);

create table if not exists members (
  chat_id bigint not null,
  user_id bigint not null,
  name text,
  joined_at timestamptz not null default now(),
  source text default 'join',
  primary key (chat_id, user_id)
);
create index if not exists members_user_idx on members (user_id);

create table if not exists posts (
  id bigserial primary key,
  channel_id bigint not null,
  message_id bigint not null,
  group_chat_id bigint,
  group_message_id bigint,
  posted_at timestamptz not null,
  status text not null default 'open',
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  unique (channel_id, message_id)
);
create index if not exists posts_due_idx on posts (channel_id, status, posted_at);
create index if not exists posts_group_idx on posts (group_chat_id, group_message_id);

create table if not exists comments (
  id bigserial primary key,
  post_id bigint not null references posts (id) on delete cascade,
  user_id bigint not null,
  group_chat_id bigint not null,
  group_message_id bigint not null,
  created_at timestamptz not null default now(),
  unique (group_chat_id, group_message_id)
);
create index if not exists comments_post_idx on comments (post_id, user_id);

create table if not exists misses (
  channel_id bigint not null,
  user_id bigint not null,
  post_id bigint not null references posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (channel_id, user_id, post_id)
);

create table if not exists whitelist (
  user_id bigint primary key,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists ban_log (
  id bigserial primary key,
  user_id bigint not null,
  user_name text,
  reason text not null,
  source_chat_id bigint,
  source_title text,
  detail text,
  ok_count integer not null default 0,
  fail_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ban_log_user_idx on ban_log (user_id, created_at desc);

create table if not exists settings (
  key text primary key,
  value jsonb
);

create table if not exists sessions (
  user_id bigint primary key,
  state text,
  data jsonb,
  updated_at timestamptz not null default now()
);

-- Keamanan: aktifkan RLS. Bot memakai service_role key sehingga tidak terpengaruh.
alter table chats enable row level security;
alter table members enable row level security;
alter table posts enable row level security;
alter table comments enable row level security;
alter table misses enable row level security;
alter table whitelist enable row level security;
alter table ban_log enable row level security;
alter table settings enable row level security;
alter table sessions enable row level security;

-- =====================================================================
-- Auto approve permintaan join (aman dijalankan ulang di database lama)
-- =====================================================================

alter table chats add column if not exists ar_enabled boolean not null default false;
alter table chats add column if not exists ar_delay_minutes integer not null default 0;
alter table chats add column if not exists ar_require_photo boolean not null default false;
alter table chats add column if not exists ar_require_bio boolean not null default false;
alter table chats add column if not exists ar_link_rule text not null default 'off';   -- off | deny | require
alter table chats add column if not exists ar_match text not null default 'all';       -- all | any
alter table chats add column if not exists ar_dm boolean not null default false;
alter table chats add column if not exists ar_dm_text text;
alter table chats add column if not exists ar_notify_admin boolean not null default true;

create table if not exists join_requests (
  id bigserial primary key,
  chat_id bigint not null,
  user_id bigint not null,
  user_chat_id bigint,
  name text,
  username text,
  requested_at timestamptz not null default now(),
  due_at timestamptz,
  status text not null default 'waiting',  -- waiting | gate | gating | manual | processing | approved | declined | gone | error
  reason text,
  dm_status text,                           -- sent | failed | skipped
  processed_by text,
  processed_at timestamptz,
  unique (chat_id, user_id)
);
create index if not exists join_requests_due_idx on join_requests (status, due_at);
create index if not exists join_requests_chat_idx on join_requests (chat_id, status);
alter table join_requests enable row level security;

-- Sinkronisasi member: kapan terakhir diverifikasi ke Telegram
alter table members add column if not exists checked_at timestamptz;

-- =====================================================================
-- Gerbang join: persetujuan aturan dan wajib join channel/grup lain
-- =====================================================================

alter table chats add column if not exists ar_agree boolean not null default false;
alter table chats add column if not exists ar_agree_text text;
alter table chats add column if not exists ar_agree_btn text;
alter table chats add column if not exists ar_force boolean not null default false;
alter table chats add column if not exists ar_force_chats jsonb not null default '[]'::jsonb;
alter table join_requests add column if not exists agreed_at timestamptz;

-- =====================================================================
-- Pesan pemberitahuan ban ke pengguna (opsional)
-- =====================================================================

alter table ban_log add column if not exists dm_status text;   -- sent | failed | skipped
