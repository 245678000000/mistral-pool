import { describe, expect, it } from 'vitest';
import { selectCandidateKeys } from '../src/lib/scheduler';
import type { ApiKeyRecord } from '../src/types';

function makeKey(overrides: Partial<ApiKeyRecord> & { id: number; name: string }): ApiKeyRecord {
  const baseTime = Date.UTC(2026, 10, 24, 6, 0, 0);
  return {
    api_key: `key-${overrides.id}`,
    enabled: 1,
    priority: overrides.id,
    status: 'healthy',
    cooldown_until: null,
    latency_ms: 300,
    month_limit_tokens: 1_000_000_000,
    month_remaining_tokens: 500_000_000,
    minute_limit_tokens: 500_000,
    minute_remaining_tokens: 500_000,
    minute_limit_req: 60,
    minute_remaining_req: 60,
    raw_rate_headers: null,
    total_requests: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    custom_note: '',
    last_checked_at: baseTime,
    last_used_at: null,
    last_error: null,
    created_at: baseTime,
    updated_at: baseTime,
    ...overrides,
  };
}

describe('selectCandidateKeys 调度器', () => {
  const now = Date.UTC(2026, 10, 24, 6, 30, 0);

  it('remaining_first 策略优先采集未探测 Key，其后严格按月剩余降序排列', () => {
    const keys = [
      makeKey({ id: 1, name: 'k1', month_remaining_tokens: 200_000 }),
      makeKey({ id: 2, name: 'k2', month_remaining_tokens: 900_000 }),
      makeKey({ id: 3, name: 'k3', month_remaining_tokens: null, minute_remaining_tokens: null, status: 'unknown' }),
      makeKey({ id: 4, name: 'k4', month_remaining_tokens: 900_000, last_used_at: now - 10_000 }),
    ];

    const ordered = selectCandidateKeys(keys, 'remaining_first', now);
    expect(ordered.map((k) => k.id)).toEqual([3, 2, 4, 1]);
  });

  it('当账号仅返回分钟 TPM 限额（无月度头）时，remaining_first 自动按分钟剩余降序优先使用大号', () => {
    const keys = [
      makeKey({ id: 1, name: 'small-500k', month_remaining_tokens: null, minute_remaining_tokens: 499_000 }),
      makeKey({ id: 2, name: 'large-10m', month_remaining_tokens: null, minute_remaining_tokens: 10_000_000 }),
      makeKey({ id: 3, name: 'mid-2m', month_remaining_tokens: null, minute_remaining_tokens: 2_000_000 }),
    ];

    const ordered = selectCandidateKeys(keys, 'remaining_first', now);
    expect(ordered.map((k) => k.id)).toEqual([2, 3, 1]);
  });

  it('round_robin 策略按最久未使用顺序派发', () => {
    const keys = [
      makeKey({ id: 1, name: 'k1', last_used_at: now - 1000 }),
      makeKey({ id: 2, name: 'k2', last_used_at: now - 5000 }),
      makeKey({ id: 3, name: 'k3', last_used_at: null }),
    ];

    const ordered = selectCandidateKeys(keys, 'round_robin', now);
    expect(ordered.map((k) => k.id)).toEqual([3, 2, 1]);
  });

  it('sequential 策略按 priority 升序消耗', () => {
    const keys = [
      makeKey({ id: 1, name: 'k1', priority: 30 }),
      makeKey({ id: 2, name: 'k2', priority: 10 }),
      makeKey({ id: 3, name: 'k3', priority: 20 }),
    ];

    const ordered = selectCandidateKeys(keys, 'sequential', now);
    expect(ordered.map((k) => k.id)).toEqual([2, 3, 1]);
  });

  it('自动过滤禁用、失效、冷却中及当月已耗尽 Key，并在冷却到期或跨月后自动恢复', () => {
    const lastMonth = Date.UTC(2026, 9, 28, 12, 0, 0); // 上个月（UTC 10月）
    const keys = [
      makeKey({ id: 1, name: 'disabled', enabled: 0 }),
      makeKey({ id: 2, name: 'invalid', status: 'invalid' }),
      makeKey({ id: 3, name: 'cooling', status: 'cooldown', cooldown_until: now + 30_000 }),
      makeKey({ id: 4, name: 'cooled-down', status: 'cooldown', cooldown_until: now - 1000 }),
      makeKey({ id: 5, name: 'exhausted-this-month', status: 'exhausted', last_checked_at: now - 5000 }),
      makeKey({ id: 6, name: 'exhausted-last-month', status: 'exhausted', last_checked_at: lastMonth }),
      makeKey({ id: 7, name: 'excluded' }),
    ];

    const ordered = selectCandidateKeys(keys, 'sequential', now, new Set([7]));
    expect(ordered.map((k) => k.id)).toEqual([4, 6]);
  });
});
