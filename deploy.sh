#!/bin/bash
# Deploy script for fuglehundprove.no
# VIKTIG: Denne scripten beskytter databasen fra å bli overskrevet

set -e

SERVER="root@135.181.28.134"
REMOTE_DIR="/var/www/fuglehundprove"

echo "=== Deploying to fuglehundprove.no ==="

# Slett eventuelle lokale db-filer FØR deploy (sikkerhetskopi)
rm -f fuglehund.db fuglehund.db-wal fuglehund.db-shm 2>/dev/null || true

# Rsync med EKSPLISITT ekskludering av alle database-filer
rsync -avz \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '*.db' \
    --exclude '*.db-wal' \
    --exclude '*.db-shm' \
    --exclude 'fuglehund.db*' \
    --exclude 'backups/' \
    ./ ${SERVER}:${REMOTE_DIR}/

echo "=== Files synced, checkpointing database ==="

# Checkpoint WAL før restart for å sikre at alle data er skrevet til hoveddatabasen
ssh ${SERVER} "cd ${REMOTE_DIR} && sqlite3 fuglehund.db 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true"

echo "=== Restarting server ==="

# Restart PM2
ssh ${SERVER} "cd ${REMOTE_DIR} && pm2 restart fuglehund"

echo "=== Deploy complete ==="
