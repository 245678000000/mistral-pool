// 核心领域类型与 Cloudflare Workers 环境变量定义

export type KeyStatus = 'unknown' | 'healthy' | 'cooldown' | 'exhausted' | 'invalid';

export type RoutingStrategy = 'remaining_first' | 'round_robin' | 'sequential';

/** 数据库中完整存储的上游 Mistral API Key 记录 */
export interface ApiKeyRecord {
  id: number;
  name: string;
  api_key: string;
  enabled: number; // 1 启用，0 停用
  priority: number;
  status: KeyStatus;
  cooldown_until: number | null;
  latency_ms: number | null;
  month_limit_tokens: number | null;
  month_remaining_tokens: number | null;
  minute_limit_tokens: number | null;
  minute_remaining_tokens: number | null;
  minute_limit_req: number | null;
  minute_remaining_req: number | null;
  raw_rate_headers: string | null;
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  custom_note: string;
  last_checked_at: number | null;
  last_used_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** 返回给前端看板的脱敏上游 API Key 视图（绝不包含明文 api_key） */
export interface MaskedApiKey extends Omit<ApiKeyRecord, 'api_key' | 'enabled' | 'raw_rate_headers'> {
  masked_key: string;
  enabled: boolean;
  raw_rate_headers: Record<string, string> | null;
}

/** 数据库中存储的下游客户端访问网关密钥记录（仅存哈希，不存明文） */
export interface ClientKeyRecord {
  id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  enabled: number;
  total_requests: number;
  total_tokens: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

/** 返回给前端的客户端访问密钥视图（不含 key_hash） */
export interface ClientKeyView extends Omit<ClientKeyRecord, 'key_hash' | 'enabled'> {
  enabled: boolean;
}

/** 从 Mistral 响应头解析出的限额与剩余额度快照 */
export interface RateLimitInfo {
  monthLimitTokens: number | null;
  monthRemainingTokens: number | null;
  minuteLimitTokens: number | null;
  minuteRemainingTokens: number | null;
  minuteLimitReq: number | null;
  minuteRemainingReq: number | null;
  queryCostTokens: number | null;
  retryAfterMs: number | null;
  rawHeaders: Record<string, string>;
}

/** 单次对话消耗的 Token 用量 */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 请求流水记录 */
export interface RequestLogRecord {
  id: number;
  key_id: number | null;
  key_name: string | null;
  client_key_name: string | null;
  endpoint: string;
  model: string | null;
  is_stream: number;
  status_code: number;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  attempts: number;
  error_summary: string | null;
  created_at: number;
}

/** 全局池设置 */
export interface PoolSettings {
  routing_strategy: RoutingStrategy;
  probe_model: string;
}

/** 今日汇总统计 */
export interface TodayStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Cloudflare Worker 绑定环境 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MISTRAL_BASE_URL?: string;
  PROXY_API_KEY?: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET?: string;
}
