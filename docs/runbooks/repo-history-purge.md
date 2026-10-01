# Repo history purge (optional, owner-only, DESTRUCTIVE)

> **DESTRUCTIVE: OWNER ONLY.** These commands rewrite every commit SHA in the repository.
> Every clone, worktree, open PR, CI cache and deploy checkout (`/opt/ai0_global`) has to be
> re-cloned or hard-reset afterwards. Nobody runs this without an explicit owner decision.
> Spec 007 (T001) only **untracked** the files and did not rewrite history.

## Why

These were committed by mistake, so they stay in the git history even after untracking:

| Path | Tracked files | Working-tree size | Status after spec 007 |
|------|---------------|-------------------|-----------------------|
| `.pnpm-store/` | 3,094 | ~19 MB (blobs) | untracked + gitignored (T001) |
| `apps/pipeline/src/raw-data/` | 614 | ~161 MB | still tracked; see [raw-data.md](raw-data.md) |

`git count-objects -vH` on 2026-10-01 showed `size-pack: 77.00 MiB`. A fresh `git clone` downloads
all of it, even though `.pnpm-store/` is no longer in `HEAD`.

## Before you start

1. Merge or close every open branch and PR. Rewritten history cannot be merged with old branches.
2. Take a mirror backup:
   ```bash
   git clone --mirror git@github.com:computer-science-improvement/ai0_global.git ai0_global-backup.git
   ```
3. Install `git-filter-repo` (`brew install git-filter-repo` or `pipx install git-filter-repo`).

## Purge `.pnpm-store/` only

```bash
# Run in a FRESH clone, not in your working checkout.
git clone git@github.com:computer-science-improvement/ai0_global.git ai0_global-purge
cd ai0_global-purge
git filter-repo --invert-paths --path .pnpm-store/
git count-objects -vH          # compare size-pack with the 77 MiB baseline
```

## Also purge raw recipe data (only once it lives elsewhere)

Run this only after `apps/pipeline/src/raw-data/` has a canonical home outside git and a fetch
script exists (see [raw-data.md](raw-data.md)). Otherwise the data is lost:

```bash
git filter-repo --invert-paths \
  --path .pnpm-store/ \
  --path apps/pipeline/src/raw-data/raw-data/recipes-splits/ \
  --path apps/pipeline/src/raw-data/raw-data/recipes-stub-125/ \
  --path apps/pipeline/src/raw-data/raw-data/recipes-ua/
# and, after the migration, the canonical copy as well:
#   --path apps/pipeline/src/raw-data/
```

## Publish the rewritten history

```bash
# filter-repo removes the `origin` remote on purpose: re-add it.
git remote add origin git@github.com:computer-science-improvement/ai0_global.git
git push --force --all origin
git push --force --tags origin
```

## After the push

- Every developer machine: re-clone. Do not `git pull` into an old clone, because that merges the
  old history back in.
- Deploy box (`/opt/ai0_global`): `git fetch origin && git reset --hard origin/<branch>`. `.env`
  and `backups/` are gitignored and survive this.
- GitHub keeps unreachable objects for a while. Ask GitHub Support to run GC if the size has to
  drop immediately.
