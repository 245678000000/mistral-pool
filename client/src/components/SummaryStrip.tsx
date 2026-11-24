import { Activity, Gauge, Layers, Zap } from 'lucide-react';
import { formatTokens } from '../api';
import type { DashboardSummary } from '../types';

interface SummaryStripProps {
  summary: DashboardSummary;
}

export function SummaryStrip({ summary }: SummaryStripProps) {
  // 优先展示月度汇总；当账号仅返回分钟 TPM 限额头时自动切换为汇总分钟可用额度
  const useMonth = summary.keysWithMonthQuota > 0;
  const useMinute = !useMonth && summary.keysWithMinuteQuota > 0;

  const quotaTitle = useMonth ? '汇总本月剩余 Token' : useMinute ? '汇总分钟剩余额度 (TPM)' : '汇总剩余 Token';
  const quotaRemaining = useMonth
    ? summary.totalMonthRemaining
    : useMinute
      ? summary.totalMinuteRemaining
      : null;
  const quotaLimit = useMonth ? summary.totalMonthLimit : useMinute ? summary.totalMinuteLimit : 0;
  const quotaCollected = useMonth ? summary.keysWithMonthQuota : summary.keysWithMinuteQuota;

  const pct =
    quotaRemaining !== null && quotaLimit > 0
      ? Math.min(100, Math.max(0, (quotaRemaining / quotaLimit) * 100))
      : null;

  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      {/* 可用账号 */}
      <div className="bg-white border border-[#E6E4DD] rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between text-xs text-[#6B6860] mb-2">
          <span>可用账号</span>
          <Layers className="w-4 h-4 text-[#9C978D]" />
        </div>
        <div className="flex items-baseline gap-1.5 tabular-nums">
          <span className="text-2xl sm:text-3xl font-semibold tracking-tight text-[#1C1B18]">
            {summary.availableKeys}
          </span>
          <span className="text-sm text-[#78746B]">/ {summary.totalKeys}</span>
        </div>
        <p className="mt-1.5 text-[11px] text-[#78746B]">
          已启用 {summary.enabledKeys} 个 · 自动容错切号
        </p>
      </div>

      {/* 汇总剩余额度（月度 / 分钟自动适配） */}
      <div className="bg-white border border-[#E6E4DD] rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between text-xs text-[#6B6860] mb-2">
          <span>{quotaTitle}</span>
          <Gauge className="w-4 h-4 text-[#E05A2B]" />
        </div>
        <div className="flex items-baseline justify-between gap-2 tabular-nums">
          <span className="text-2xl sm:text-3xl font-semibold tracking-tight text-[#1C1B18]">
            {quotaRemaining !== null ? formatTokens(quotaRemaining) : '待刷新'}
          </span>
          {pct !== null && (
            <span className="text-xs font-medium text-[#E05A2B]">{pct.toFixed(1)}%</span>
          )}
        </div>
        {pct !== null ? (
          <div className="mt-2.5">
            <div className="h-1.5 w-full bg-[#EFECE6] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-[#E05A2B] transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-[#78746B] tabular-nums">
              已采集 {quotaCollected}/{summary.enabledKeys} 个 · 总限额 {formatTokens(quotaLimit)}
            </p>
          </div>
        ) : (
          <p className="mt-1.5 text-[11px] text-[#78746B]">点击“全部测活刷新”获取官方剩余</p>
        )}
      </div>

      {/* 今日请求次数 */}
      <div className="bg-white border border-[#E6E4DD] rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between text-xs text-[#6B6860] mb-2">
          <span>今日调用</span>
          <Activity className="w-4 h-4 text-[#9C978D]" />
        </div>
        <div className="text-2xl sm:text-3xl font-semibold tracking-tight text-[#1C1B18] tabular-nums">
          {summary.today.requests}
        </div>
        <p className="mt-1.5 text-[11px] text-[#78746B] tabular-nums">
          历史累计 {summary.totalAllTimeRequests} 次请求
        </p>
      </div>

      {/* 今日 Token 消耗 */}
      <div className="bg-white border border-[#E6E4DD] rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between text-xs text-[#6B6860] mb-2">
          <span>今日 Token 消耗</span>
          <Zap className="w-4 h-4 text-[#9C978D]" />
        </div>
        <div className="text-2xl sm:text-3xl font-semibold tracking-tight text-[#1C1B18] tabular-nums">
          {formatTokens(summary.today.totalTokens)}
        </div>
        <p className="mt-1.5 text-[11px] text-[#78746B] tabular-nums">
          历史累计 {formatTokens(summary.totalAllTimeTokens)}
        </p>
      </div>
    </section>
  );
}
