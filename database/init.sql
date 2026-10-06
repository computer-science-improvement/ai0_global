-- ============================================================================
-- AI0 Global — Database Schema
-- Idempotent: safe to run multiple times (CREATE IF NOT EXISTS)
-- ============================================================================

-- ─── Content: assets (academy resources, prompts-md, mcpservers) ────────────

-- Since migration 058 (spec 032) `assets` is a compatibility view over data_items; skip it then.
do $init_assets$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.assets') and relkind = 'v') then
  create table if not exists assets (
    id          uuid primary key default gen_random_uuid(),
    data_source text not null,
    title       text not null default '',
    description text not null default '',
    link        text,
    source_url  text,
    category    text,
    extra       jsonb,
    posted      jsonb not null default '{}',
    created_at  timestamptz not null default now()
  );

  create index if not exists idx_assets_data_source  on assets (data_source);
  create index if not exists idx_assets_category     on assets (category);
  create index if not exists idx_assets_created_at   on assets (created_at desc);
  create index if not exists idx_assets_posted       on assets using gin (posted);
  create unique index if not exists idx_assets_unique on assets (data_source, title);

  -- Full-text search
  create index if not exists idx_assets_fts
    on assets using gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '')));
end if;
end $init_assets$;

-- ─── Content: prompts (ai0-prompts strategy) ───────────────────────────────

-- Since migration 058 (spec 032) `prompts` is a compatibility view over data_items; skip it then.
do $init_prompts$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.prompts') and relkind = 'v') then
  create table if not exists prompts (
    id            text primary key,
    prompt_source text not null,
    category      text,
    posted        jsonb not null default '{}',
    scraped_at    timestamptz,
    page_url      text,
    status        text,
    provider      text not null default 'prompthero',
    title         text,
    prompt_text   text,
    source        text,
    media_url     text,
    media_type    text,
    created_at    timestamptz not null default now()
  );

  create index if not exists idx_prompts_category on prompts (category);
  create index if not exists idx_prompts_posted   on prompts using gin (posted);
  create index if not exists idx_prompts_status   on prompts (status);
  create index if not exists idx_prompts_provider on prompts (provider);
end if;
end $init_prompts$;

-- ─── Content: on_this_day (on-this-day strategy) ───────────────────────────

-- Since migration 058 (spec 032) `on_this_day` is a compatibility view over data_items; skip it then.
do $init_on_this_day$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.on_this_day') and relkind = 'v') then
  create table if not exists on_this_day (
    id          uuid primary key default gen_random_uuid(),
    day         smallint not null,
    month       smallint not null,
    title       text not null,
    slug        text not null,
    excerpt     text,
    description text,
    image_url   text,
    tags        text[] not null default '{}',
    posted      jsonb not null default '{}',
    created_at  timestamptz not null default now()
  );

  create unique index if not exists idx_on_this_day_unique on on_this_day (month, day, slug);
  create index if not exists idx_on_this_day_date          on on_this_day (month, day);
end if;
end $init_on_this_day$;

-- ─── Content: articles ─────────────────────────────────────────────────────

-- Since migration 058 (spec 032) `articles` is a compatibility view over data_items; skip it then.
do $init_articles$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.articles') and relkind = 'v') then
  create table if not exists articles (
    id          uuid primary key default gen_random_uuid(),
    title       text not null,
    slug        text not null unique,
    url         text not null,
    excerpt     text,
    content     text,
    image_url   text,
    category    text,
    tags        text[] not null default '{}',
    posted      jsonb not null default '{}',
    created_at  timestamptz not null default now()
  );

  create index if not exists idx_articles_category on articles (category);
end if;
end $init_articles$;

-- ─── Content: jokes ────────────────────────────────────────────────────────

-- Since migration 058 (spec 032) `jokes` is a compatibility view over data_items; skip it then.
do $init_jokes$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.jokes') and relkind = 'v') then
  create table if not exists jokes (
    id           uuid primary key default gen_random_uuid(),
    title        text,
    content      text not null,
    content_hash text not null,
    url          text,
    posted       jsonb not null default '{}',
    created_at   timestamptz not null default now()
  );

  create unique index if not exists idx_jokes_hash on jokes (content_hash);
end if;
end $init_jokes$;

-- ─── Content: quotes ───────────────────────────────────────────────────────

-- Since migration 058 (spec 032) `quotes` is a compatibility view over data_items; skip it then.
do $init_quotes$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.quotes') and relkind = 'v') then
  create table if not exists quotes (
    id           uuid primary key default gen_random_uuid(),
    text         text not null,
    text_hash    text not null,
    author       text,
    category     text,
    url          text,
    posted       jsonb not null default '{}',
    created_at   timestamptz not null default now()
  );

  create unique index if not exists idx_quotes_hash     on quotes (text_hash);
  create index if not exists idx_quotes_category        on quotes (category);
end if;
end $init_quotes$;

-- ─── Content: recipes ─────────────────────────────────────────────────────

-- Since migration 058 (spec 032) `recipes` is a compatibility view over data_items; skip it then.
do $init_recipes$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.recipes') and relkind = 'v') then
  create table if not exists recipes (
    id           uuid primary key default gen_random_uuid(),
    title        text not null,
    slug         text not null,
    url          text,
    description  text,
    ingredients  text,
    instructions text,
    image_url    text,
    category     text,
    tags         text[] not null default '{}',
    post_text    text,
    posted       jsonb not null default '{}',
    title_uk        TEXT,
    ingredients_uk  TEXT,
    instructions_uk TEXT,
    translated_at   TIMESTAMPTZ,
    telegraph_url   TEXT,
    telegraph_path  TEXT,
    kcal            numeric,
    protein_g       numeric,
    fat_g           numeric,
    carbs_g         numeric,
    serving_size_g  numeric,
    raw          jsonb,
    created_at   timestamptz not null default now()
  );

  create unique index if not exists idx_recipes_slug     on recipes (slug);
  create index if not exists idx_recipes_category        on recipes (category);
  create index if not exists idx_recipes_posted          on recipes using gin (posted);
  create index if not exists idx_recipes_untranslated on recipes (created_at) where title_uk is null;
end if;
end $init_recipes$;

-- ─── Infrastructure: posted_news (dedup tracking) ──────────────────────────

-- ─── Content: facts (faktypro.com.ua strategy) ────────────────────────────

-- Since migration 058 (spec 032) `facts` is a compatibility view over data_items; skip it then.
do $init_facts$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.facts') and relkind = 'v') then
  create table if not exists facts (
    id            uuid primary key default gen_random_uuid(),
    article_slug  text not null,
    article_title text not null,
    article_url   text,
    image_url     text,
    content       text not null,
    content_hash  text not null,
    category      text,
    posted        jsonb not null default '{}',
    created_at    timestamptz not null default now()
  );

  create unique index if not exists idx_facts_hash         on facts (content_hash);
  create index if not exists idx_facts_article_slug        on facts (article_slug);
  create index if not exists idx_facts_category            on facts (category);
  create index if not exists idx_facts_posted              on facts using gin (posted);
end if;
end $init_facts$;

-- ─── Content: name_days (іменини) ────────────────────────────────────────

-- Since migration 058 (spec 032) `name_days` is a compatibility view over data_items; skip it then.
do $init_name_days$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.name_days') and relkind = 'v') then
  create table if not exists name_days (
    id         uuid primary key default gen_random_uuid(),
    month      smallint not null,
    day        smallint not null,
    name       text not null,
    created_at timestamptz not null default now()
  );

  create unique index if not exists idx_name_days_unique on name_days (month, day, name);
  create index if not exists idx_name_days_date          on name_days (month, day);
end if;
end $init_name_days$;

-- ─── Content: birthdays (дні народження відомих людей) ────────────────────

-- Since migration 058 (spec 032) `birthdays` is a compatibility view over data_items; skip it then.
do $init_birthdays$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.birthdays') and relkind = 'v') then
  create table if not exists birthdays (
    id         uuid primary key default gen_random_uuid(),
    month      smallint not null,
    day        smallint not null,
    year       smallint,
    name       text not null,
    posted     jsonb not null default '{}',
    created_at timestamptz not null default now()
  );

  create unique index if not exists idx_birthdays_unique on birthdays (month, day, name);
  create index if not exists idx_birthdays_date          on birthdays (month, day);
  create index if not exists idx_birthdays_posted        on birthdays using gin (posted);
end if;
end $init_birthdays$;

-- ─── Content: pdr_questions (PDR ticket questions) ────────────────────────

-- Since migration 058 (spec 032) `pdr_questions` is a compatibility view over data_items; skip it then.
do $init_pdr_questions$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.pdr_questions') and relkind = 'v') then
  create table if not exists pdr_questions (
    id                 uuid primary key default gen_random_uuid(),
    question_id        integer not null,
    ticket_number      smallint not null,
    question_num       smallint not null,
    text               text not null,
    image_url          text,
    answers            jsonb not null default '[]',
    correct_answer_num smallint not null,
    explanation        text not null default '',
    posted             jsonb not null default '{}',
    created_at         timestamptz not null default now()
  );

  create unique index if not exists idx_pdr_questions_qid     on pdr_questions (question_id);
  create index if not exists idx_pdr_questions_order          on pdr_questions (ticket_number, question_num);
  create index if not exists idx_pdr_questions_posted         on pdr_questions using gin (posted);
end if;
end $init_pdr_questions$;

-- ─── Infrastructure: posted_news (dedup tracking) ──────────────────────────

create table if not exists posted_news (
  id           uuid primary key default gen_random_uuid(),
  source_url   text not null,
  title        text,
  channel_id   text not null,
  content_type text,
  created_at   timestamptz not null default now()
);

create unique index if not exists idx_posted_news_unique
  on posted_news (source_url, channel_id);
create index if not exists idx_posted_news_channel
  on posted_news (channel_id);
create index if not exists idx_posted_news_recent
  on posted_news (channel_id, created_at desc);

-- ─── Infrastructure: bot_logs ──────────────────────────────────────────────

create table if not exists bot_logs (
  id         uuid primary key default gen_random_uuid(),
  source_url text not null,
  channel_id text not null,
  type       text not null check (type in ('success', 'error')),
  message    text,
  created_at timestamptz not null default now()
);

create index if not exists idx_bot_logs_source
  on bot_logs (source_url, channel_id);
create index if not exists idx_bot_logs_channel
  on bot_logs (channel_id);

-- ─── Infrastructure: ai_logs ───────────────────────────────────────────────

create table if not exists ai_logs (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null,
  model       text not null,
  status      text not null check (status in ('success', 'error')),
  input       jsonb not null,
  output      text,
  error       text,
  duration_ms integer,
  created_at  timestamptz not null default now()
);

create index if not exists idx_ai_logs_agent      on ai_logs (agent);
create index if not exists idx_ai_logs_status     on ai_logs (status);
create index if not exists idx_ai_logs_created_at on ai_logs (created_at desc);

-- ─── Content: tg_posts (адаптовані пости для Telegram-каналів) ────────────

-- Since migration 058 (spec 032) `tg_posts` is a compatibility view over data_items; skip it then.
do $init_tg_posts$ begin
if not exists (select 1 from pg_class where oid = to_regclass('public.tg_posts') and relkind = 'v') then
  create table if not exists tg_posts (
    id           uuid primary key default gen_random_uuid(),
    source       text not null,        -- 'daytoday-self-development' | 'samorozvytok-motivatory'
    source_url   text not null,
    title        text not null,
    image_url    text,
    post         text not null,        -- готовий текст посту (HTML Telegram)
    content_hash text not null,        -- md5(post) для дедупу
    author             text,
    source_published_at timestamptz,
    tags         text[] not null default '{}',
    posted       jsonb not null default '{}',
    created_at   timestamptz not null default now()
  );

  create unique index if not exists idx_tg_posts_content_hash on tg_posts (content_hash);
  create index if not exists idx_tg_posts_source             on tg_posts (source);
  create index if not exists idx_tg_posts_posted             on tg_posts using gin (posted);
end if;
end $init_tg_posts$;
