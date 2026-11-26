-- 新增按日汇总表（北京时间 YYYY-MM-DD），使看板今日统计从扫描日志表降为单行主键点查

CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
