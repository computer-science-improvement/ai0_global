# Supabase setup

## Option 1: Create table in Supabase Dashboard (recommended)

1. Open [Supabase Dashboard](https://supabase.com/dashboard) and select your project.
2. Go to **SQL Editor** (left sidebar).
3. Click **New query**.
4. Paste the contents of `scripts/schema.sql`:

```sql
create table if not exists prompts (
  id            text primary key,
  prompt_source text not null,
  category      text,
  posted        boolean default false
);

create index if not exists prompts_category_idx on prompts (category);
create index if not exists prompts_posted_idx on prompts (posted);
```

5. Click **Run** (or Cmd/Ctrl+Enter).

Done. Then run `npm run seed` to fill the table.

---

## Option 2: Create table from JS (Node script)

If you prefer to run the schema from your machine:

1. Get your **database connection string**  
   Supabase Dashboard → **Project Settings** → **Database** → **Connection string** → **URI** (copy and replace `[YOUR-PASSWORD]` with the database password).

2. Set it in `.env`:
   ```env
   DATABASE_URL=postgresql://postgres.[project-ref]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```

3. Install the Postgres client and run the init script:
   ```bash
   npm install pg
   node scripts/init-table.js
   ```

The script runs the same SQL as `schema.sql` and creates the table. Then run `npm run seed`.
