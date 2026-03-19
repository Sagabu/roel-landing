# Fuglehundprøve — Deploy & Status Map

> Last updated: 2026-03-19

## Production Server

| Key | Value |
|-----|-------|
| **Domain** | `fuglehundprove.no` (HTTPS, auto Let's Encrypt) |
| **IP** | `135.181.28.134` |
| **Server** | Hetzner CX23, `ubuntu-4gb-hel1-1`, 4GB RAM |
| **SSH** | `ssh -i ~/.ssh/id_ed25519 root@135.181.28.134` |
| **App dir** | `/var/www/fuglehund` |
| **Process** | PM2 (`pm2 list`, `pm2 restart fuglehund`, `pm2 logs fuglehund`) |
| **Reverse proxy** | Caddy (`/etc/caddy/Caddyfile`) |
| **Port** | 8889 (internal), 443 (public) |
| **Node** | v22 |

## Environment (on server)

```
NODE_ENV=production
PORT=8889
JWT_SECRET=<set>
JWT_EXPIRES_IN=7d
DB_PATH=./fuglehund.db
ADMIN_PIN=Hund69
```

No Sveve SMS credentials configured yet — SMS auth is UI-only for now.

## Git State (after merge 2026-03-19)

**Main is now current.** Branch `vk/d4e8-fortsett-fra-mai` (58 commits) merged into main.

What's in main now:
- Dog CRUD API (create/update/delete)
- Login flow fixes (min-side.html, auth.js)
- Survey system (dommer-undersokelse.html)
- Party distribution logic
- Cache-busting headers
- Admin panel improvements (single-page layout)
- Judge interface updates (VK, kritikk)
- Club management
- Navbar fixes
- 75+ API endpoints in server.js (4053 lines)

## Server vs Main — Delta

The server is behind current main. Key gaps:
- Missing: dog CRUD API endpoints (`POST/PUT/DELETE /api/hunder`) — **this is why saving dogs doesn't work**
- Missing: `dommer-undersokelse.html` (survey page, never deployed)
- Missing: latest mine-hunder.html + min-side.html updates
- Server has: `import_cli.cjs` + `import_cli.js` (created on server, not in git)

## Bugs Fixed (2026-03-19)

### Bug 1: Missing CRUD routes (root cause)
Server's `server.js` had no `POST /api/hunder`, `PUT /api/hunder/:id`, or `DELETE /api/hunder/:id`.
Frontend calls them → 404 → nothing saves. Fixed: routes now in main.

### Bug 2: `bilde` column missing from DB
`INSERT INTO hunder` writes a `bilde` column that doesn't exist in the schema.
Fixed: added to CREATE TABLE + migration for existing databases.

### Bug 3: `regnr` NOT NULL constraint
Schema had `regnr TEXT UNIQUE NOT NULL` but frontend sends `null` when user skips registration number.
Fixed: changed to `regnr TEXT UNIQUE` (nullable) + migration to rebuild table on existing DBs.

### Bug 4: PUT field mapping broken
Frontend sends `fodselsdato`, PUT handler iterates `["fodt", ...]` — never matches.
Birthday updates silently dropped. Fixed: proper field mapping with `fodselsdato → fodt`.

### DB migration note
On first restart after deploy, server.js will auto-migrate the `hunder` table:
- Adds `bilde` column
- Rebuilds table to make `regnr` nullable
- All existing data preserved (transaction-safe)

## How to Deploy (redeploy)

### Option A: Quick (recommended now)

From this machine (caisa WSL):

```bash
cd /mnt/c/Users/CAISA/roel-landing

# 1. Sync all files to server (excluding git, node_modules, db)
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'fuglehund.db*' \
  --exclude '.env' \
  -e "ssh -i ~/.ssh/id_ed25519" \
  ./ root@135.181.28.134:/var/www/fuglehund/

# 2. Install deps if package.json changed
ssh -i ~/.ssh/id_ed25519 root@135.181.28.134 "cd /var/www/fuglehund && npm install --production"

# 3. Restart
ssh -i ~/.ssh/id_ed25519 root@135.181.28.134 "pm2 restart fuglehund"
```

### Option B: Set up git on server (recommended long-term)

```bash
ssh -i ~/.ssh/id_ed25519 root@135.181.28.134
cd /var/www/fuglehund
git init
git remote add origin https://github.com/Sagabu/roel-landing.git
git fetch origin
git checkout -f main
npm install --production
pm2 restart fuglehund
```

After that, redeploy is just:
```bash
ssh -i ~/.ssh/id_ed25519 root@135.181.28.134 "cd /var/www/fuglehund && git pull && npm install --production && pm2 restart fuglehund"
```

### Option C: Script it

A `redeploy.sh` at repo root that does Option A or B in one command.

## Stale Branches (safe to delete)

These are all older parallel forks — their useful work is already in main via d4e8 or was superseded:

| Branch | Commits | Status |
|--------|---------|--------|
| `vk/d4e8-fortsett-fra-mai` | 58 | **MERGED** — can delete |
| `vk/2a9d-fullf-r-auth-dep` | 74 | Stale, auth/deploy work — superseded |
| `vk/e029-opprydding-merge` | 73 | Stale, merge cleanup — superseded |
| `vk/67fc-continue-fuglehu` | 72 | Stale, continuation — superseded |
| `vk/eef4-continue-fuglehu` | 69 | Stale, continuation — superseded |
| `vk/fdfb-koble-html-siden` | 3 | Stale, HTML wiring — in main |
| `vk/db00-fiks-dev-server` | 3 | Stale, dev server fix — in main |
| `vk/535b-bytt-til-backend` | 3 | Stale, backend switch — in main |
| `vk/9ec4-deploy-fuglehund` | 2 | Deploy files — already in main |
| `vk/b98b-build-roel-s-lan` | 1 | Landing page — superseded |
| `vk/0e0e-sveve-sms-auth-h` | 1 | Sveve SMS stub — not wired yet |

## What's NOT Done Yet

1. **SMS auth** — Sveve credentials not configured, auth is UI-only
2. **Dog search wiring** — `dog-search.js` exists but not loaded on all pages
3. **Trial config** — some pages still hardcode "Høgkjølprøven 2026"
4. **Proper relational tables** — still using kv_store bridge for most data
5. **Backup automation** — manual only via `/api/backup`
6. **import_cli** — exists on server only, should be in git if needed

## Database

- SQLite WAL mode at `/var/www/fuglehund/fuglehund.db`
- Backup: `curl https://fuglehundprove.no/api/backup -o backup.db`
- Current: 2 users, 0 dogs, 0 clubs, 1 trial config, 4 admin log entries
- There's a `fuglehund.db.corrupt` file on server — old crash artifact, safe to remove
