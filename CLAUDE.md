# Fuglehundprøve

Event management platform for Norwegian bird dog field trials.

## ⚠️ KRITISK: Deploy-rutine

**ALDRI bruk vanlig rsync for deploy!** Bruk ALLTID denne kommandoen:

```bash
./deploy.sh
```

Eller hvis du MÅ bruke rsync manuelt, ALLTID inkluder:
```bash
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' --exclude 'fuglehund.db*' --exclude 'backups/' ./ root@135.181.28.134:/var/www/fuglehundprove/
```

**HVORFOR:** Databasen `fuglehund.db` inneholder alle brukere, hunder, prøver, etc. Hvis den overskrives med en lokal tom fil, mistes ALL data.

**Server:** root@135.181.28.134
**Remote dir:** /var/www/fuglehundprove/
**PM2 restart:** `ssh root@135.181.28.134 "cd /var/www/fuglehundprove && pm2 restart fuglehund"`

## ⚠️ VIKTIG: Les reglene først!

**Før du gjør NOEN endringer på kritikker, premieberegning, eller avlsstatistikk:**

Les `REGLER_FUGLEHUNDPROVER.md` - den inneholder alle offisielle regler som MÅ følges.

### Kritiske regler (kortversjon):

1. **Klasser:**
   - UK = 9 mnd til 2 år
   - AK = fra fylte 2 år
   - VK = etter oppnådd 1. AK
   - **Man kan ALDRI gå tilbake til lavere klasse**

2. **1. premie krever:**
   - Minimum 60 min slipptid (men garanterer ikke 1. premie alene)

3. **1. AK krever (hunden må være "ren"):**
   - Fuglearbeid med godkjent reis
   - **makker_stand = 0** (ingen makkerstand)
   - **sjanse = 0** (ingen sjanser på fugl)
   - tomstand = 0
   - slipptid ≥ 60 min

4. **Avlsindekser (NISK-modell):**
   - 100 = rasesnitt
   - Kun jaktlyst og viltfinnerevne brukes
   - Minimum 5 starter for pålitelig indeks
   - Skogsprøver ekskluderes

## Architecture

**Frontend**: 13 HTML pages (Tailwind CDN, vanilla JS) — already built, fully functional.
**Backend**: Node.js + Hono + SQLite via `better-sqlite3`.
**Data bridge**: `storage-shim.js` intercepts localStorage calls and syncs to SQLite via REST API. Pages work identically to before, but data now persists in a real database.

### How the shim works

Every HTML page gets `<script src="/storage-shim.js">` injected automatically by the server. The shim:
1. Overrides `localStorage.setItem` → writes local AND fires PUT to `/api/storage/:key`
2. Overrides `localStorage.removeItem` → removes local AND fires DELETE
3. On page load, hydrates localStorage from server state (pull down)
4. Shows a "Tilkoblet — SQLite" badge when connected

**You don't need to change any existing page code.** The shim handles everything transparently.

### Synced localStorage keys

These keys are automatically persisted to SQLite:
- `userProfile`, `userDogs`, `userTrials`, `userMandates`
- `judgeSession`, `clubLogo`
- `judgeData_*` (per-party judge scoring, dynamic keys)

To add a new synced key, add it to the `SYNCED_KEYS` array in `storage-shim.js`.

## Running

```bash
npm install          # first time only
npm start            # serves on http://localhost:8889
npm run dev          # with --watch for auto-restart
```

Pages: `http://localhost:8889/` (index), `/admin.html`, `/deltaker.html`, `/dommer.html`, etc.
Admin panel: `http://localhost:8889/admin-panel.html`
Database backup: `http://localhost:8889/api/backup` (downloads .db file)

## API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/storage` | List all stored keys |
| GET | `/api/storage/:key` | Get value for key |
| PUT | `/api/storage/:key` | Set value `{ "value": ... }` |
| DELETE | `/api/storage/:key` | Remove key |
| GET | `/api/trial` | Get trial configuration |
| PUT | `/api/trial` | Update trial config fields |
| GET | `/api/admin/log` | Admin change history |
| GET | `/api/stats` | Dashboard stats |
| GET | `/api/backup` | Download SQLite database file |

## Task: Wire remaining pages to use backend data

The backend is running and the shim bridges localStorage to SQLite. The next step is making the pages load real data and function as a complete application.

### What's done
- Server serves all 13 pages with shim injection
- localStorage writes sync to SQLite automatically
- Admin panel for trial configuration (name, dates, location, club, publish status)
- Database backup endpoint
- Design system preserved (forest/earth/bark colors, Rockwell font)

### What to do next

**Priority 1 — Navigation**: Wire all pages together with consistent nav. Every page should have working links to the others. The nav structure:
- Public: index.html, partilister.html, hund.html
- Participant (logged in): deltaker.html, profil.html, mine-hunder.html, jaktprover.html, fullmakter.html
- Judge (logged in): dommer.html → dommer-hjem.html → dommer-vk.html
- Admin: admin.html, klubb.html
- Backend admin: admin-panel.html

**Priority 2 — Auth flow**: The SMS login in `dommer.html` is UI-only. For now, make it work with a simple localStorage session (phone number → stored as logged in). Real SMS auth can come later.

**Priority 3 — Trial config from backend**: The admin panel stores trial config in SQLite. Update `admin.html` and `index.html` to fetch trial name/dates/location from `/api/trial` instead of hardcoding "Høgkjølprøven 2026".

**Priority 4 — Dog search**: `dog-search.js` is a standalone module. Make sure it's loaded on all pages that need it (index, hund, mine-hunder).

### File overview

| File | Lines | Role |
|------|-------|------|
| server.js | ~130 | Hono server, API routes, shim injection |
| storage-shim.js | ~80 | localStorage → SQLite bridge |
| admin-panel.html | ~200 | Backend admin (trial config, data explorer, log) |
| admin.html | 2058 | Trial administration dashboard |
| deltaker.html | 994 | Participant registration and overview |
| dommer-vk.html | 1864 | Judge scoring interface (mobile-first) |
| mine-hunder.html | 890 | Dog registry CRUD |
| partilister.html | 690 | Public party lists |
| hund.html | 625 | Individual dog profile |
| fullmakter.html | 533 | Mandate/authorization management |
| index.html | 466 | Landing page + search |
| jaktprover.html | 448 | Trial results history |
| profil.html | 420 | User profile |
| klubb.html | 379 | Club management |
| dommer.html | 367 | Judge SMS login |
| dommer-hjem.html | 361 | Judge home (party selection) |
| dog-search.js | 246 | Reusable dog search module |

### Design system

Colors (already in every page's tailwind config):
- `forest-*`: Green primary (nav, buttons, accents)
- `earth-*`: Brown secondary (links, hover states)
- `bark-*`: Neutral (text, backgrounds, borders)

Font: Rockwell for headings, system sans for body. Class: `font-rockwell`.

### Database

SQLite file: `fuglehund.db` (created automatically on first run). Back it up anytime via `/api/backup` or just copy the file.

Tables:
- `kv_store`: key-value bridge from localStorage (all page data lives here)
- `trial_config`: editable trial settings (1 row)
- `admin_log`: change history

When you need proper relational tables (e.g., a `dogs` table with columns instead of a JSON blob), create a migration in server.js and add API routes. The kv_store bridge is a stepping stone — graduate keys to proper tables as the domain solidifies.
