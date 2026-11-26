import { beforeEach, describe, expect, it } from 'vitest';
import { clearSettingsCache, D1PoolRepository, getBeijingDayKey } from '../src/db/repository';

interface RecordedSql {
  sql: string;
  args: unknown[];
}

/** 轻量 Mock D1Database，用于验证 SQL 形态、低频主键裁剪、daily_stats 懒建表与 settings 缓存 */
function createMockD1(options?: {
  lastRowId?: number;
  missingDailyStatsOnce?: boolean;
  dailyRow?: Record<string, unknown> | null;
  settingsRows?: Array<{ key: string; value: string }>;
}) {
  const executed: RecordedSql[] = [];
  let missingDaily = options?.missingDailyStatsOnce ?? false;
  let lastRowId = options?.lastRowId ?? 1;

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async run() {
          executed.push({ sql, args: bound });
          if (sql.includes('CREATE TABLE IF NOT EXISTS daily_stats')) {
            missingDaily = false;
            return { meta: { changes: 0, last_row_id: 0 } };
          }
          if (sql.includes('INSERT INTO daily_stats') && missingDaily) {
            throw new Error('D1_ERROR: no such table: daily_stats');
          }
          if (sql.includes('INSERT INTO request_logs')) {
            return { meta: { changes: 1, last_row_id: lastRowId++ } };
          }
          return { meta: { changes: 1, last_row_id: 0 } };
        },
        async first<T>() {
          executed.push({ sql, args: bound });
          if (sql.includes('FROM daily_stats') && missingDaily) {
            throw new Error('D1_ERROR: no such table: daily_stats');
          }
          if (sql.includes('FROM daily_stats')) {
            return (options?.dailyRow ?? null) as T;
          }
          return null as T;
        },
        async all<T>() {
          executed.push({ sql, args: bound });
          if (sql.includes('FROM settings')) {
            return { results: (options?.settingsRows ?? []) as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  };

  return { db: db as unknown as D1Database, executed };
}

describe('D1PoolRepository 低行读优化验证', () => {
  beforeEach(() => {
    clearSettingsCache();
  });

  it('按北京时间自然日正确生成 daily_stats 主键', () => {
    // 2026-11-26 16:30 UTC 对应北京时间 2026-11-27 00:30
    expect(getBeijingDayKey(Date.UTC(2026, 10, 26, 16, 30, 0))).toBe('2026-11-27');
    // 2026-11-26 15:59 UTC 对应北京时间 2026-11-26 23:59
    expect(getBeijingDayKey(Date.UTC(2026, 10, 26, 15, 59, 0))).toBe('2026-11-26');
  });

  it('insertLogAndPrune 非裁剪周期不执行 DELETE，命中 25 周期时只走主键范围删除且绝不含 NOT IN', async () => {
    const { db, executed } = createMockD1({ lastRowId: 524 });
    const repo = new D1PoolRepository(db);
    const baseLog = {
      key_id: 1,
      key_name: 'mistral 1',
      client_key_name: 'iPhone',
      endpoint: '/v1/chat/completions',
      model: 'mistral-small-latest',
      is_stream: 1,
      status_code: 200,
      latency_ms: 300,
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      attempts: 1,
      error_summary: null,
      created_at: Date.UTC(2026, 10, 26, 6, 0, 0),
    };

    // 第 524 行：不触发 DELETE
    await repo.insertLogAndPrune(baseLog);
    expect(executed.some((q) => q.sql.includes('DELETE FROM request_logs'))).toBe(false);

    // 第 525 行（525 % 25 === 0 且 > 500）：触发主键范围删除 id <= 25
    await repo.insertLogAndPrune(baseLog);
    const deleteCalls = executed.filter((q) => q.sql.includes('DELETE FROM request_logs'));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].sql).toBe('DELETE FROM request_logs WHERE id <= ?');
    expect(deleteCalls[0].args).toEqual([25]);
    expect(executed.some((q) => q.sql.includes('NOT IN'))).toBe(false);
  });

  it('daily_stats 表缺失时自动懒建表兜底，且 getTodayStats 仅做单行主键查询', async () => {
    const { db, executed } = createMockD1({
      lastRowId: 10,
      missingDailyStatsOnce: true,
      dailyRow: { requests: 12, promptTokens: 100, completionTokens: 200, totalTokens: 300 },
    });
    const repo = new D1PoolRepository(db);

    await repo.insertLogAndPrune({
      key_id: 1,
      key_name: 'm1',
      client_key_name: null,
      endpoint: '/v1/chat/completions',
      model: 'mistral-small-latest',
      is_stream: 0,
      status_code: 200,
      latency_ms: 200,
      prompt_tokens: 5,
      completion_tokens: 5,
      total_tokens: 10,
      attempts: 1,
      error_summary: null,
      created_at: Date.UTC(2026, 10, 26, 6, 0, 0),
    });

    expect(executed.some((q) => q.sql.includes('CREATE TABLE IF NOT EXISTS daily_stats'))).toBe(true);

    const stats = await repo.getTodayStats(Date.UTC(2026, 10, 26, 6, 0, 0));
    expect(stats).toEqual({ requests: 12, promptTokens: 100, completionTokens: 200, totalTokens: 300 });
    expect(executed.some((q) => q.sql.includes('FROM request_logs') && q.sql.includes('COUNT(*)'))).toBe(false);
  });

  it('getSettings 在 TTL 内命中进程缓存不重复读 D1，updateSettings 后立即失效', async () => {
    const { db, executed } = createMockD1({
      settingsRows: [{ key: 'routing_strategy', value: 'round_robin' }],
    });
    const repo = new D1PoolRepository(db);

    const s1 = await repo.getSettings();
    const s2 = await repo.getSettings();
    expect(s1.routing_strategy).toBe('round_robin');
    expect(s2.routing_strategy).toBe('round_robin');
    expect(executed.filter((q) => q.sql.includes('FROM settings'))).toHaveLength(1);

    await repo.updateSettings({ routing_strategy: 'sequential' });
    expect(executed.filter((q) => q.sql.includes('FROM settings'))).toHaveLength(2);
  });
});
