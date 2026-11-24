-- 初始化 Mistral 多号池数据库结构

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until INTEGER,
  latency_ms INTEGER,
  month_limit_tokens INTEGER,
  month_remaining_tokens INTEGER,
  minute_limit_tokens INTEGER,
  minute_remaining_tokens INTEGER,
  minute_limit_req INTEGER,
  minute_remaining_req INTEGER,
  raw_rate_headers TEXT,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  total_completion_tokens INTEGER NOT NULL DEFAULT 0,
  custom_note TEXT NOT NULL DEFAULT '',
  last_checked_at INTEGER,
  last_used_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_enabled_priority
  ON api_keys (enabled, priority, id);

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER,
  key_name TEXT,
  endpoint TEXT NOT NULL,
  model TEXT,
  is_stream INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  error_summary TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at
  ON request_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
