# Fuglehundprøve

Event management-plattform for norske fuglehundprøver (fuglehundprove.no).

## ⚠️ KRITISKE regler — les FØRST

### Deploy
**ALDRI kjør `rsync` direkte mot produksjon.** Bruk `./deploy.sh`. Scripten har nå en sikkerhetssjekk som nekter deploy ved uncommittet eller upushet arbeid — la den gjøre jobben sin. `DEPLOY_FORCE=1 ./deploy.sh` overstyrer kun i ekte nødstilfeller.

### Database
`fuglehund.db` på server inneholder all produksjonsdata (brukere, hunder, prøver, kritikker, klubber). `deploy.sh` ekskluderer `*.db` og `backups/` fra rsync. Hvis du noen gang må jobbe mot produksjons-DB, ta backup først (auto-backups ligger i `/var/www/fuglehundprove/backups/` hvert 30. min).

### Forretningsregler
**Les `REGLER_FUGLEHUNDPROVER.md` før du rører kritikk-skjema, premie-logikk eller avlsstatistikk.** Reglene er offisielle FKF/NKK-regler. Backend håndhever dem **ikke** automatisk i dag (se seksjon "Business rules" nederst) — det er frontend-ansvar. Ikke lag tilfeldige validerings-endringer uten å konsultere reglene.

## Produksjon
- **Server:** root@135.181.28.134
- **Remote dir:** `/var/www/fuglehundprove/`
- **Process:** PM2 `fuglehund` (restart: `ssh root@135.181.28.134 "cd /var/www/fuglehundprove && pm2 restart fuglehund"`)
- **Auto-backup:** hvert 30. min via `backup-cron.sh` + cron, lagres i `backups/`
- **SSL/proxy:** Caddy (se `Caddyfile`)

## Stack

| Lag | Teknologi |
|---|---|
| Backend | Node.js + Hono + `better-sqlite3` |
| Frontend | ~60 HTML-sider, Tailwind CDN, vanilla JS (ingen framework) |
| Auth | JWT (12t TTL) + bcrypt + SMS-OTP |
| SMS | Sveve (primær) + Twilio (fallback) |
| Betaling | Vipps ePayment API (per-klubb konfigurasjon, API-nøkler AES-256 kryptert i DB) |
| Deploy | rsync + PM2 |

## Kjøre lokalt
```bash
npm install              # første gang
npm start                # http://localhost:8889
npm run dev              # --watch for auto-restart
```

## server.js — struktur (~14 000 linjer, monolittisk)

Linjetallene er omtrentlige. server.js er bevisst ett-filet for enkel deploy.

| Område | Linjer (ca) | Innhold |
|---|---|---|
| Imports, config, kryptering | 1–120 | Hono, JWT, AES-256-GCM for Vipps-nøkler |
| DB setup + schema | 122–1260 | 39 `CREATE TABLE`, migrations, indexes |
| Seed-data | 1269–1603 | Demo-data (dev-mode) |
| App init + middleware | 1605–1732 | `requireAuth`, `requireAdmin`, `requireDommer` |
| Passord, sesjon, re-verifisering | 1735–1840 | bcrypt + SHA256-legacy upgrade |
| SMS-system | 1841–2480 | Sveve/Twilio, køsystem, retry |
| OTP + login-endepunkter | 2480–3680 | SMS-login, passord-login, klubb-login, forgot-password |
| Site-lock + admin-lock | 3680–3736 | PIN-basert access |
| Storage-shim + trial-config | 3736–3795 | `/api/storage/:key` + `/api/trial` |
| Brukere | 4107–4310 | CRUD, GDPR-export |
| Hunder | 4360–4705 | CRUD, NKK-lookup, aversjons-/eierbevis |
| Klubber | 4710–5016 | CRUD, logo, medlemsimport |
| Klubb-forespørsler | 5016–5342 | Nye klubber venter på godkjenning |
| Superadmin | 5342–5870 | Brukerlisting, GDPR, SMS-stats, testkontoer |
| Vipps | 5870–6580 | Forespørsler, mottakere, webhook |
| Dommer-tildelinger + forespørsler + oppgjør | 6572–7280 | Judge workflow |
| Prøver (CRUD + config) | 7280–7775 | Trial creation, config, partier |
| Påmeldinger + avmeldinger | 7775–8437 | Trial registrations, waitlist |
| Partifordeling, trekning | 9158–9490 | Random draw, party assignment |
| Avlsindekser + statistikk | 9849–9935 | Hund-stats, avkom |
| Sertifikater | 9973–10500 | Aversjons-/eierbevis, signing |
| Kritikk-workflow | 10677–11003 | Opprett → submit → NKK-godkjenn |
| Rapporter + versjonering | 10892–11351 | Signerte PDF-rapporter |
| Meldinger | 11948–12296 | Bruker ↔ admin-meldinger |
| DVK + dokumenter | 12645–13441 | Journal, kontrollsignering |
| VK-bedømmelse | 13469–13980 | Live-rangering, dommer-notater |
| Statiske filer + catch-all | slutt | Auto-injiserer `/auth.js`, `/storage-shim.js` i HTML |

## Database — 39 tabeller

### Kjerne-entiteter
| Tabell | Hva |
|---|---|
| `brukere` | Brukerprofiler. PK = `telefon`. Kolonner: fornavn, etternavn, rolle (komma-sep: admin, proveleder, klubbleder, dommer, nkkrep, superadmin), passord_hash, sms_samtykke, verifisert |
| `klubber` | Klubbinfo. PK = `id`. Inkluderer `vipps_client_id/secret/subscription_key/merchant_serial` (krypterte) og `vipps_api_modus` |
| `hunder` | Hunde-register. PK = `id`, `regnr` UNIQUE. FK til eier + klubb + far/mor |
| `prover` | Prøver. Inkluderer `proveleder_telefon`, `nkkrep_telefon`, `nkkvara_telefon`, `dvk_telefon`, `klasser` (JSON), `partier` (JSON) |
| `partier` | Parti-gruppering (ukak/vk per dato/klasse) |

### Påmelding/avmelding
`pameldinger`, `avmeldinger` (med `lopetid_egenerklaring` JSON), `ventende_fullmakter`, `fullmakter`, `jegermiddag_pameldinger`

### Dommer-system
`dommer_tildelinger`, `dommer_foresporsler`, `dommer_oppgjor` (reise, diett, passasjerer, fradrag)

### Kritikk + VK
`kritikker` (fulle 1–6 egenskapsskalaer, slipptid, premie, status, `meddommer_telefon`), `resultater`, `vk_bedomming`, `dommer_notater`, `parti_signaturer`, `fratatte_aversjonsbevis`

### Klubb-relatert
`klub_admins`, `klub_medlemmer` (med matching mot `brukere.telefon`), `klub_foresporsel`, `klub_dokumenter`, `fkf_godkjente_dommere`

### SMS + Vipps
`sms_queue` (priority, retry), `sms_log`, `otp_codes`, `vipps_foresporsler`, `vipps_mottakere` (matches på `vipps_reference` i webhook), `rolle_sms_sendt`

### Rapporter + dokumenter
`rapport_versjoner` (signert med `signed_at`/`signed_by`), `rapport_logg`, `prove_dokumenter`, `dvk_kontroller`, `dvk_signaturer`, `dvk_journaler`

### Konfig + audit
`trial_config` (én rad), `prove_config` (per-prøve: max_deltakere_*, pris_*, jegermiddag_*, vk_type 1/2/3-dag), `partifordeling_regler`, `admin_log`, `meldinger`, `undersokelser`, `kv_store` (legacy localStorage-bridge)

## API-routes — ~150 endepunkter

Grupperte områder (ikke uttømmende, se server.js for full liste):

- **Auth** (~20): `/api/auth/{send-code,verify-code,login,login-password,register/*,klubb/*,reverify/*,forgot-password/*,me,refresh,logout,consent}`
- **Site-lock + admin-lock** (4): `/api/site-lock/*`, `/api/admin-lock/*`
- **Storage bridge** (4): `/api/storage/:key`
- **Trial config** (2): `/api/trial`
- **Brukere** (7): `/api/brukere/:telefon/*`
- **Hunder** (10): `/api/hunder/*`, `/api/hunder/:id/{statistikk,avkom,aversjonsbevis,eierbevis}`
- **Klubber** (12): `/api/klubber/:id/*`, `/api/klubber/:id/{logo,admins,medlemmer,dokumenter}`
- **Klubb-forespørsler** (3): `/api/klubb-foresporsel/*`
- **Prøver** (25+): `/api/prover/:id/{config,partier,partilister,venteliste,trekning,jegermiddag,fratatte-aversjonsbevis,rapport-logg,sms-historikk,rolle-sms,...}`
- **Påmeldinger** (5): `/api/prover/:id/pameldinger`, `/api/mine-pameldinger`, `/api/prover/:id/avmeldinger`
- **Dommer-system** (12): `/api/dommere`, `/api/prover/:id/dommer-tildelinger`, `/api/dommer-foresporsler/*`, `/api/dommer-oppgjor/*`
- **Kritikker** (10): `/api/kritikker/*` inkl. `/{submit,godkjenn,returner,send-til-meddommer,bekreft-meddommer}`
- **VK-bedømmelse** (8): `/api/vk-bedomming/:proveId/:parti/*`, `/api/vk-rangering`, `/api/dommer-notater`
- **Vipps** (3): `/api/prover/:id/vipps-foresporsler`, `/api/vipps/webhook` (no auth)
- **SMS** (5): `/api/sms/*`, `/api/superadmin/sms-queue/*`
- **Superadmin** (15): `/api/superadmin/*`
- **Dokumenter + rapporter** (10): `/api/prove-dokumenter/*`, `/api/rapport-versjoner/*`
- **Fullmakter** (3): `/api/brukere/:telefon/fullmakter`
- **DVK + journaler** (5): `/api/dvk-kontroller/*`, `/api/dvk-journal/*`
- **Meldinger** (6): `/api/meldinger/*`
- **Misc** (8): `/api/stats/*`, `/api/system/health`, `/api/backups/*`, `/api/parse-participants`, `/api/import-participants`, `/api/gdpr/analyser-bilde`, `/api/undersokelse`

## Auth-flyt

1. **SMS-login (primær)**: `/api/auth/send-code` → SMS-OTP (15 min TTL) → `/api/auth/verify-code` → JWT (12t) → lagres i `localStorage['fuglehund_token']` + `localStorage['fuglehund_user']`
2. **Passord-login**: `/api/auth/login-password` (bcrypt)
3. **Klubb-login**: `/api/auth/klubb/login` (org.nr + passord, JWT inneholder klubb_id)
4. **Re-verifisering**: >60 dager siden sist → `/api/auth/reverify/*`

**Frontend:** `auto.js` auto-injiseres i alle HTML-sider. Eksponerer `FuglehundAuth.{isLoggedIn, hasRole, authFetch, logout}`. 60 min inaktivitet = client-side auto-logout. 401 → redirect til `/min-side.html`.

**Sidebeskyttelse:** `PROTECTED_PAGES`-map i `auth.js` (f.eks. `admin.html → 'admin'`, `dommer-hjem.html → 'dommer'`).

**Site-lock + admin-lock:** PIN via env `SITE_PIN` og `ADMIN_PIN`.

## HTML-sider

### Offentlig (ingen innlogging)
`index.html`, `slik-fungerer-det.html`, `personvern.html`, `veiledning.html`, `undersokelse.html`, `dommer-undersokelse.html`, `opprett-bruker.html`, `opprett-klubb.html`, `terminliste.html`

### Deltaker (innlogget)
`min-side.html` (login-hub), `profil.html`, `mine-hunder.html`, `jaktprover.html`, `fullmakter.html`, `pamelding.html`, `partilister.html`, `hund.html`, `avlssok.html`, `prove-arkiv.html`, `klubb-login.html`, `upload-logo.html`

### Dommer (role=dommer)
`dommer.html`, `dommer-hjem.html`, `dommer-kritikk.html`, `dommer-kritikker.html`, `dommer-vk.html`, `dommer-vk-test.html`, `dommer-ukak.html`, `dommer-ukak-test.html`, `dommer-ukak-dual.html`, `dommer-foresporsler.html`, `dommer-mitt-oppgjor.html`, `dommer-oppgjor.html`, `kritikk-visning.html`, diverse `dommertest*.html`

### Admin / klubb-admin
`admin.html` (hoved-hub for prøveadmin), `opprett-prove.html`, `klubb.html`, `klubb-dokumenter.html`, `flytskjema-klubb.html`, `nkk-godkjenning.html`, `dvk-kontroll.html`, `dvktest.html`

### Superadmin
`superadmin.html`, `admin-panel.html` (backend data-explorer, audit-log, backups), `vipps-callback.html`

## Storage-shim — status

`storage-shim.js` bygger bro fra `localStorage` → SQLite via `/api/storage/:key`. Fortsatt aktiv for legacy-nøkler:
`userProfile`, `userDogs`, `userTrials`, `userMandates`, `judgeSession`, `clubLogo`, dynamiske `judgeData_*`/`trialParties_*`.

**Nye features bruker direkte API-kall** (ikke shim) — f.eks. `/api/hunder`, `/api/kritikker`, `/api/prover/:id/pameldinger`. Migrerer gradvis vekk fra shim-modellen.

## SMS

**Providere** (i prioritetsrekkefølge):
1. **Sveve** — env `SVEVE_USER`, `SVEVE_PASS`, `SVEVE_FROM`. GET `https://sveve.no/SMS/SendMessage?...&f=json`
2. **Twilio** — env `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (eller `TWILIO_MESSAGING_SERVICE_SID` for alfa-avsender)
3. **Dev mode** — logger til console hvis ingen provider er konfigurert

**Køsystem:** `sms_queue`-tabell med `priority` (1–10, lavere = tidligere), `status` (pending/processing/sent/failed/cancelled), `attempts` (max 3). Processor kjører hvert 5. sekund, sender maks 10 per batch, 1s forsinkelse mellom hver.

**Rate-limit:** Masse-SMS per prøve: maks 3 ganger per time, 5 min cooldown mellom.

**Kjente endpoints:** `/api/auth/send-code`, `/api/prover/:id/sms/masse` (requireAdmin), `/api/prover/:id/rolle-sms` (roll-spesifikk melding).

## Vipps

Hver klubb har egne API-nøkler (ePayment API) kryptert i `klubber.vipps_*`-kolonner.

Flyt:
1. `POST /api/prover/:id/vipps-foresporsler` → oppretter `vipps_foresporsler` + én `vipps_mottakere` per mottaker (med unik `vipps_reference`)
2. Bruker betaler i Vipps-appen → returnerer til `vipps-callback.html`
3. Vipps sender webhook: `POST /api/vipps/webhook` med `{reference, state}` → matcher mot `vipps_mottakere.vipps_reference`, setter status=betalt hvis state ∈ {AUTHORIZED, CAPTURED, SALE}

Webhook-registrering skjer i Vipps Merchant Portal per klubb (se `.env.example` for instruks).

## Klubb-modell

Hver klubb eier sine egne:
- Prøver (`prover.klubb_id`)
- Dommer-admins (`klubb_admins`)
- Medlemsliste (`klub_medlemmer`, med matching mot eksisterende `brukere`)
- Dokumenter (`klub_dokumenter`)
- Vipps-integrasjon (egen merchant/subscription)

Klubb-opprettelse er en todelt flyt: request i `klub_foresporsel` → superadmin godkjenner → klubb opprettes i `klubber`.

## Forretningsregler — håndhevelsesstatus

`REGLER_FUGLEHUNDPROVER.md` inneholder alle offisielle regler. Viktig å vite **hvor reglene faktisk håndheves**:

| Regel | Status | Hvor |
|---|---|---|
| Klassekrav (UK/AK/VK) + "aldri tilbake" | ✅ Håndhevet | `klasse-validator.js` ved påmelding |
| Kritikk-duplikatsjekk (per dag/hund) | ✅ Håndhevet | `POST /api/kritikker` |
| Premiekrav (60 min slipptid, godkjent reis osv.) | ⚠️ IKKE håndhevet i backend | Frontend bør vise advarsel, men `POST /api/kritikker` aksepterer hva som helst |
| 1. AK "ren"-krav (makker_stand=0, sjanse=0, tomstand=0) | ⚠️ IKKE håndhevet | Dommer må manuelt sette |
| Obligatoriske egenskaper 1–6 | ⚠️ IKKE håndhevet | Lagres, men ingen NOT NULL-sjekk |
| Avlsindekser NISK-modell (100=snitt, min 5 starter, eksl. skogsprøver) | ❌ Ikke implementert | `/api/hunder/:id/avkom-statistikk` beregner kun rå snitt |

**Før du endrer kritikk-/premielogikk:** bekreft med bruker om det er en ren UI-endring eller om backend-validering også skal legges til.

## Vanlige arbeidsoppgaver

- **Legge til ny API-route:** åpne relevant seksjon i `server.js`, følg mønsteret (Hono `app.<verb>(path, middleware, handler)`). Bruk `requireAuth`/`requireAdmin`/`requireDommer` der det trengs.
- **Legge til ny DB-kolonne:** `ALTER TABLE` i migrations-seksjonen (rundt linje 1070), oppdater INSERT/UPDATE-queries. Ingen formell migrations-framework — bare idempotente `ALTER` med `try/catch`.
- **Endre HTML-side:** finn filen, bruk Tailwind-klasser. Husk at `auth.js` og `storage-shim.js` auto-injiseres av server.
- **Legge til SMS-type:** queue med `queueSMS(telefon, melding, {type, priority})`. Velg priority: OTP=1, admin-handling=3, massesending=8.
- **Debug produksjon:** `pm2 logs fuglehund --lines 100` på server.

## Design system

Farger (Tailwind-config er i hver HTML-side):
- `forest-*` — grønn (nav, primære knapper)
- `earth-*` — brun (sekundær, lenker, hover)
- `bark-*` — nøytral (tekst, bakgrunner)
- `warm-*` — oransje-gul aksent (ny, fra vk/91c6-økten)

Font: **Rockwell** for overskrifter (`font-rockwell`), system sans for brødtekst.
