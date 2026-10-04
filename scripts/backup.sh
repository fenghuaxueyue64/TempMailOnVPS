#!/usr/bin/env bash
# scripts/backup.sh — SQLite 安全备份（WAL 模式下必须用 .backup 命令，不能直接 cp）
# 用法：
#   手动：./scripts/backup.sh
#   定时（crontab）：0 2 * * * /opt/tempmail/scripts/backup.sh >> /var/log/tempmail-backup.log 2>&1
#
# 保留策略：默认保留最近 7 天，可通过 KEEP_DAYS 环境变量调整

set -euo pipefail

# 配置（可被环境变量覆盖）
DB_PATH="${DB_PATH:-/app/data/db/tempmail.db}"
BACKUP_DIR="${BACKUP_DIR:-/app/data/backup}"
KEEP_DAYS="${KEEP_DAYS:-7}"
CONTAINER_NAME="${CONTAINER_NAME:-tempmail-app}"

# 容器内执行 sqlite3；宿主机直接运行脚本时也可用 sqlite3 命令
SQLITE_CMD="${SQLITE_CMD:-sqlite3}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M)
BACKUP_FILE="$BACKUP_DIR/backup-$TIMESTAMP.db"

echo "[$(date -Iseconds)] backing up $DB_PATH → $BACKUP_FILE"

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  # 容器运行中：通过 docker exec 调用容器内的 sqlite3
  docker exec "$CONTAINER_NAME" "$SQLITE_CMD" "$DB_PATH" ".backup '$BACKUP_FILE'"
else
  # 容器未运行：直接用宿主机 sqlite3
  "$SQLITE_CMD" "$DB_PATH" ".backup '$BACKUP_FILE'"
fi

if [ -f "$BACKUP_FILE" ]; then
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo "[$(date -Iseconds)] ✓ backup created: $BACKUP_FILE ($SIZE)"
else
  echo "[$(date -Iseconds)] ✗ backup failed" >&2
  exit 1
fi

# 清理过期备份
echo "[$(date -Iseconds)] pruning backups older than ${KEEP_DAYS} days..."
find "$BACKUP_DIR" -name "backup-*.db" -mtime "+${KEEP_DAYS}" -delete
echo "[$(date -Iseconds)] ✓ done"
