#!/bin/sh
set -eu
backup_dir="${BACKUP_DIR:-/opt/apps/lb26/backups}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/lb26-$timestamp.sql.gz"
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl | gzip -9 > "$target"
gzip -t "$target"
find "$backup_dir" -type f -name 'lb26-*.sql.gz' -mtime "+$retention_days" -delete
echo "$target"
