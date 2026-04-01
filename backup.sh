#!/bin/bash
# Backup script for fuglehundprove.no database
# Kjør dette FØR prøvestart for å sikre data

set -e

SERVER="root@135.181.28.134"
REMOTE_DIR="/var/www/fuglehundprove"
LOCAL_BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "=== Database Backup for fuglehundprove.no ==="

# Opprett lokal backup-mappe
mkdir -p ${LOCAL_BACKUP_DIR}

# Checkpoint WAL først for å sikre alle data er skrevet
echo "Checkpointing WAL..."
ssh ${SERVER} "cd ${REMOTE_DIR} && sqlite3 fuglehund.db 'PRAGMA wal_checkpoint(TRUNCATE);'"

# Lag backup på server
echo "Creating backup on server..."
ssh ${SERVER} "mkdir -p ${REMOTE_DIR}/backups && cp ${REMOTE_DIR}/fuglehund.db ${REMOTE_DIR}/backups/fuglehund_${TIMESTAMP}.db"

# Last ned backup lokalt
echo "Downloading backup locally..."
scp ${SERVER}:${REMOTE_DIR}/backups/fuglehund_${TIMESTAMP}.db ${LOCAL_BACKUP_DIR}/

# Vis backup-info
echo ""
echo "=== Backup complete ==="
echo "Server backup: ${REMOTE_DIR}/backups/fuglehund_${TIMESTAMP}.db"
echo "Local backup:  ${LOCAL_BACKUP_DIR}/fuglehund_${TIMESTAMP}.db"

# Vis størrelse
ls -lh ${LOCAL_BACKUP_DIR}/fuglehund_${TIMESTAMP}.db

# List eksisterende backups på server
echo ""
echo "=== Server backups ==="
ssh ${SERVER} "ls -lh ${REMOTE_DIR}/backups/*.db 2>/dev/null | tail -10" || echo "Ingen tidligere backups"

echo ""
echo "Tips: Kjør './backup.sh' før hver prøvedag for å sikre data."
