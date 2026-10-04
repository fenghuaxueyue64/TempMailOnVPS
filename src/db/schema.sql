-- src/db/schema.sql
-- 开启 WAL 模式（写不阻塞读，并发性能关键）
PRAGMA journal_mode = WAL;
PRAGMA cache_size   = -32000;     -- 32 MB 内存页缓存
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store   = MEMORY;

CREATE TABLE IF NOT EXISTS domains (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain     TEXT    UNIQUE NOT NULL,
  is_active  BOOLEAN DEFAULT 1,
  mx_synced  BOOLEAN DEFAULT 0,          -- deSEC MX 是否已配置
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id         TEXT    PRIMARY KEY,        -- UUID v7
  address    TEXT    UNIQUE NOT NULL,    -- "alice@tmp.io"
  domain     TEXT    NOT NULL,
  user_id    TEXT,                       -- NULL = 匿名
  token      TEXT    NOT NULL,           -- 访问令牌（URL 携带）
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mb_address ON mailboxes(address);
CREATE INDEX IF NOT EXISTS idx_mb_token   ON mailboxes(token);
CREATE INDEX IF NOT EXISTS idx_mb_expires ON mailboxes(expires_at);

CREATE TABLE IF NOT EXISTS emails (
  id           TEXT PRIMARY KEY,         -- UUID v7
  mailbox_id   TEXT NOT NULL,
  message_id   TEXT,
  from_address TEXT NOT NULL,
  from_name    TEXT,
  to_address   TEXT NOT NULL,
  subject      TEXT,
  body_text    TEXT,
  body_html    TEXT,
  raw_size     INTEGER DEFAULT 0,
  is_read      BOOLEAN DEFAULT 0,
  received_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_em_mailbox ON emails(mailbox_id, received_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  email_id     TEXT NOT NULL,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  file_path    TEXT NOT NULL,            -- 相对于 ATT_DIR
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE,
  api_key    TEXT UNIQUE,
  plan       TEXT DEFAULT 'free',      -- free | pro | admin
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 邀请码：一次性使用，换 JWT。code 即用户标识（mailboxes.user_id 存 code）
CREATE TABLE IF NOT EXISTS invitations (
  code       TEXT    PRIMARY KEY,        -- 32 位 hex
  note       TEXT,                        -- admin 备注（如"给张三"）
  used_at     DATETIME,                    -- NULL = 未使用
  expires_at  DATETIME NOT NULL,           -- 邀请码自身过期时间
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inv_used   ON invitations(used_at);
CREATE INDEX IF NOT EXISTS idx_inv_exp    ON invitations(expires_at);
