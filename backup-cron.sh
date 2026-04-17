#!/bin/bash
# Daglig backup av fuglehund.db
# Kjøres via cron hver natt kl 03:00

BACKUP_DIR="/var/www/fuglehundprove/backups"
DB_FILE="/var/www/fuglehundprove/fuglehund.db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
KEEP_DAYS=30

# Checkpoint WAL først
cd /var/www/fuglehundprove
sqlite3 $DB_FILE 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null

# Lag backup
cp $DB_FILE $BACKUP_DIR/fuglehund_$TIMESTAMP.db

# Komprimer backups eldre enn 1 dag
find $BACKUP_DIR -name '*.db' -mtime +1 -exec gzip {} \; 2>/dev/null

# Slett backups eldre enn KEEP_DAYS dager
find $BACKUP_DIR -name '*.db.gz' -mtime +$KEEP_DAYS -delete 2>/dev/null

echo "[$(date)] Backup completed: fuglehund_$TIMESTAMP.db"
