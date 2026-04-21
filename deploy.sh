#!/bin/bash
# Deploy script for fuglehundprove.no
# VIKTIG: Denne scripten beskytter databasen fra å bli overskrevet

set -e

SERVER="root@135.181.28.134"
REMOTE_DIR="/var/www/fuglehundprove"

# === PRE-DEPLOY SIKKERHETSSJEKK ===
# Nekter å kjøre hvis det er uncommittet eller upushet arbeid.
# Sett DEPLOY_FORCE=1 for å overstyre (bruk kun i nødstilfeller).

if [ -z "$DEPLOY_FORCE" ]; then
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        echo "❌ ABORT: Du har uncommittede endringer."
        echo ""
        git status --short
        echo ""
        echo "Commit og push først. Eller sett DEPLOY_FORCE=1 hvis du VET hva du gjør."
        exit 1
    fi

    git fetch origin --quiet 2>/dev/null || true
    LOCAL=$(git rev-parse @ 2>/dev/null)
    REMOTE=$(git rev-parse @{u} 2>/dev/null || echo "")
    if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
        AHEAD=$(git rev-list --count @{u}..@ 2>/dev/null || echo "?")
        BEHIND=$(git rev-list --count @..@{u} 2>/dev/null || echo "?")
        if [ "$AHEAD" != "0" ]; then
            echo "❌ ABORT: Du har $AHEAD commits som ikke er pushet til origin."
            echo "Kjør: git push"
            echo "Eller sett DEPLOY_FORCE=1 for å overstyre."
            exit 1
        fi
        if [ "$BEHIND" != "0" ]; then
            echo "⚠️  ADVARSEL: Du er $BEHIND commits bak origin. Bør pull-e før deploy."
            echo "Sett DEPLOY_FORCE=1 for å fortsette likevel, eller kjør: git pull"
            exit 1
        fi
    fi

    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
    echo "✓ Git clean. Branch: $BRANCH. HEAD: $(git rev-parse --short HEAD 2>/dev/null)"
fi

echo "=== Deploying to fuglehundprove.no ==="

# Slett eventuelle lokale db-filer FØR deploy (sikkerhetskopi)
rm -f fuglehund.db fuglehund.db-wal fuglehund.db-shm 2>/dev/null || true

# Rsync med EKSPLISITT ekskludering av alle database-filer og sensitive env-filer.
# VIKTIG: .env må ALDRI synkroniseres fra lokal maskin — den inneholder
# prod-kredentialer (SMS/Vipps/JWT) som kun skal vedlikeholdes direkte på serveren.
# Lokal .env er for lokal utvikling og har typisk dev-verdier som ville slått ut
# ekte SMS-provider og satt NODE_ENV=development på prod.
rsync -avz \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '*.db' \
    --exclude '*.db-wal' \
    --exclude '*.db-shm' \
    --exclude 'fuglehund.db*' \
    --exclude 'backups/' \
    --exclude '.env' \
    --exclude '.env.*' \
    ./ ${SERVER}:${REMOTE_DIR}/

echo "=== Files synced, checkpointing database ==="

# Checkpoint WAL før restart for å sikre at alle data er skrevet til hoveddatabasen
ssh ${SERVER} "cd ${REMOTE_DIR} && sqlite3 fuglehund.db 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true"

echo "=== Restarting server ==="

# Restart PM2
ssh ${SERVER} "cd ${REMOTE_DIR} && pm2 restart fuglehund"

echo "=== Deploy complete ==="
