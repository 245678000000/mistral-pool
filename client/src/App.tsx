import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Layers,
  LogOut,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { adminApi, ApiError, STRATEGY_LABELS } from './api';
import { ClientKeysPanel } from './components/ClientKeysPanel';
import { KeyCard } from './components/KeyCard';
import { AddKeyModal, EditKeyModal } from './components/KeyModals';
import { LoginView } from './components/LoginView';
import { ClientGuide, LogsPanel } from './components/LogsPanel';
import { PlaygroundModal } from './components/PlaygroundModal';
import { SummaryStrip } from './components/SummaryStrip';
import type { DashboardPayload, MaskedApiKey, RequestLogRecord, RoutingStrategy } from './types';

export function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState<'pool' | 'client-keys'>('pool');

  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [logs, setLogs] = useState<RequestLogRecord[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const [probingAll, setProbingAll] = useState(false);
  const [probingKeyIds, setProbingKeyIds] = useState<Set<number>>(new Set());

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingKey, setEditingKey] = useState<MaskedApiKey | null>(null);
  const [showPlayground, setShowPlayground] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  const [copiedBase, setCopiedBase] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const pushToast = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ text, tone });
    window.setTimeout(() => {
      setToast((prev) => (prev?.text === text ? null : prev));
    }, 3200);
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const data = await adminApi.getDashboard();
      setDashboard(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuthenticated(false);
        return;
      }
      pushToast(err instanceof Error ? err.message : '拉取看板数据失败', 'err');
    }
  }, [pushToast]);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const res = await adminApi.getLogs(80);
      setLogs(res.logs);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAuthenticated(false);
      }
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  // 启动时校验当前会话
  useEffect(() => {
    adminApi
      .getSession()
      .then((res) => {
        setAuthenticated(res.authenticated);
      })
      .catch(() => {
        setAuthenticated(false);
      })
      .finally(() => {
        setAuthChecked(true);
      });
  }, []);

  // 登录后拉取看板与流水，并开启 30 秒静默同步
  useEffect(() => {
    if (!authenticated) return;
    loadDashboard();
    loadLogs();
    const poll = window.setInterval(() => {
      loadDashboard();
    }, 30_000);
    return () => window.clearInterval(poll);
  }, [authenticated, loadDashboard, loadLogs]);

  // 1 秒全局时钟节拍，驱动冷却倒计时与相对时间流畅刷新
  useEffect(() => {
    if (!authenticated) return;
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, [authenticated]);

  const handleCopyBaseUrl = async () => {
    if (!dashboard) return;
    try {
      await navigator.clipboard.writeText(dashboard.proxyBaseUrl);
      setCopiedBase(true);
      pushToast('已复制聚合接口地址，可直接填入 AI 客户端');
      window.setTimeout(() => setCopiedBase(false), 1800);
    } catch {
      pushToast('复制失败，请手动展开接入指南复制', 'err');
    }
  };

  const handleProbeAll = async () => {
    setProbingAll(true);
    try {
      const res = await adminApi.probeAll();
      await loadDashboard();
      const okCount = res.results.filter((r) => r.ok).length;
      pushToast(`全部测活完成：${okCount} / ${res.results.length} 个账号正常`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '测活失败', 'err');
    } finally {
      setProbingAll(false);
    }
  };

  const handleProbeSingle = async (id: number) => {
    setProbingKeyIds((prev) => new Set(prev).add(id));
    try {
      const res = await adminApi.probeKey(id);
      await loadDashboard();
      if (res.result.ok) {
        pushToast(`${res.result.name} 测活正常（${res.result.latencyMs} ms）`);
      } else {
        pushToast(`${res.result.name} 异常：${res.result.error || '探测失败'}`, 'err');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '测活失败', 'err');
    } finally {
      setProbingKeyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleToggleEnabled = async (item: MaskedApiKey) => {
    try {
      await adminApi.updateKey(item.id, { enabled: !item.enabled });
      await loadDashboard();
      pushToast(`${item.name} 已${item.enabled ? '停用' : '启用'}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '操作失败', 'err');
    }
  };

  const handleResetStatus = async (item: MaskedApiKey) => {
    try {
      await adminApi.updateKey(item.id, { reset_status: true });
      await loadDashboard();
      pushToast(`已清除 ${item.name} 的异常/冷却状态`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '重置失败', 'err');
    }
  };

  const handleDelete = async (item: MaskedApiKey) => {
    if (!window.confirm(`确定要从号池中删除「${item.name}」（${item.masked_key}）吗？`)) {
      return;
    }
    try {
      await adminApi.deleteKey(item.id);
      await loadDashboard();
      pushToast(`已删除 ${item.name}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '删除失败', 'err');
    }
  };

  const handleStrategyChange = async (strategy: RoutingStrategy) => {
    try {
      await adminApi.updateSettings({ routing_strategy: strategy });
      await loadDashboard();
      pushToast(`调度策略已切换为「${STRATEGY_LABELS[strategy].label}」`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '策略切换失败', 'err');
    }
  };

  const handleLogout = async () => {
    await adminApi.logout().catch(() => {});
    setAuthenticated(false);
    setDashboard(null);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center text-xs text-[#78746B]">
        正在加载看板...
      </div>
    );
  }

  if (!authenticated) {
    return <LoginView onSuccess={() => setAuthenticated(true)} />;
  }

  return (
    <div className="min-h-screen pb-14">
      {/* 顶部导航栏 */}
      <header className="sticky top-0 z-30 bg-[#F7F6F2]/90 backdrop-blur-md border-b border-[#E6E4DD]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-15 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-[#E05A2B] flex items-center justify-center text-white font-bold text-sm shrink-0">
              M
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#1C1B18] truncate">Mistral Pool</div>
              <div className="text-[11px] text-[#78746B] hidden sm:block">多号池统一网关 · 实时剩余监控</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {dashboard && (
              <button
                type="button"
                onClick={handleCopyBaseUrl}
                className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-[#E2DFD7] hover:border-[#E05A2B] text-xs font-mono text-[#57534E] transition-colors cursor-pointer"
              >
                <span>{dashboard.proxyBaseUrl}</span>
                {copiedBase ? (
                  <Check className="w-3.5 h-3.5 text-[#15803D]" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-[#9C978D]" />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={handleLogout}
              title="退出登录"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs text-[#6B6860] hover:text-[#1C1B18] hover:bg-[#EAE7DF] transition-colors cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">退出</span>
            </button>
          </div>
        </div>
      </header>

      {/* 主内容容器 */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-5 space-y-5">
        {dashboard ? (
          <>
            {/* 顶部 4 卡汇总 */}
            <SummaryStrip summary={dashboard.summary} />

            {/* 二级主导航页签：Mistral 号池 vs 网关访问密钥 */}
            <nav className="flex items-center justify-between gap-3 border-b border-[#E6E4DD] pb-3">
              <div className="inline-flex p-1 rounded-xl bg-[#ECEAE3] text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setActiveTab('pool')}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
                    activeTab === 'pool'
                      ? 'bg-white text-[#1C1B18] shadow-xs'
                      : 'text-[#6B6860] hover:text-[#1C1B18]'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Mistral 号池</span>
                  <span className="text-[11px] tabular-nums px-1.5 py-0.2 rounded-full bg-[#F3F2EE] text-[#57534E]">
                    {dashboard.summary.totalKeys}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('client-keys')}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
                    activeTab === 'client-keys'
                      ? 'bg-white text-[#1C1B18] shadow-xs'
                      : 'text-[#6B6860] hover:text-[#1C1B18]'
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>网关 API Keys</span>
                  <span className="text-[11px] tabular-nums px-1.5 py-0.2 rounded-full bg-[#F3F2EE] text-[#57534E]">
                    {dashboard.summary.totalClientKeys}
                  </span>
                </button>
              </div>
            </nav>

            {activeTab === 'pool' ? (
              <>
                {/* 号池操作工具栏 */}
                <section className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddModal(true)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#E05A2B] hover:bg-[#C94B1F] text-white text-xs font-medium shadow-xs transition-colors cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>添加 / 批量导入 Key</span>
                    </button>

                    <button
                      type="button"
                      disabled={probingAll || dashboard.keys.length === 0}
                      onClick={handleProbeAll}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-[#DFDDD5] hover:border-[#C5C0B5] disabled:opacity-50 text-[#1C1B18] text-xs font-medium transition-colors cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${probingAll ? 'animate-spin text-[#E05A2B]' : ''}`} />
                      <span>{probingAll ? '全量测活中...' : '全部测活刷新'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={dashboard.keys.length === 0}
                      onClick={() => setShowPlayground(true)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border border-[#DFDDD5] hover:border-[#C5C0B5] disabled:opacity-50 text-[#1C1B18] text-xs font-medium transition-colors cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-[#E05A2B]" />
                      <span>在线测试</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowGuide((v) => !v)}
                      className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium transition-colors cursor-pointer ${
                        showGuide
                          ? 'bg-[#FFF4EE] border-[#F6C8B3] text-[#C94B1F]'
                          : 'bg-white border-[#DFDDD5] text-[#57534E] hover:text-[#1C1B18]'
                      }`}
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      <span>接入指南</span>
                    </button>
                  </div>

                  {/* 调度策略选择器 */}
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className="w-3.5 h-3.5 text-[#78746B] shrink-0" />
                    <span className="text-xs text-[#6B6860] shrink-0">调度策略：</span>
                    <select
                      value={dashboard.settings.routing_strategy}
                      onChange={(e) => handleStrategyChange(e.target.value as RoutingStrategy)}
                      className="px-2.5 py-1.5 rounded-xl bg-white border border-[#DFDDD5] text-xs font-medium text-[#1C1B18] focus:outline-none focus:border-[#E05A2B] cursor-pointer"
                    >
                      {(Object.keys(STRATEGY_LABELS) as RoutingStrategy[]).map((key) => (
                        <option key={key} value={key}>
                          {STRATEGY_LABELS[key].label}
                        </option>
                      ))}
                    </select>
                  </div>
                </section>

                {/* 客户端接入指南 */}
                {(showGuide || dashboard.keys.length === 0) && (
                  <ClientGuide
                    proxyBaseUrl={dashboard.proxyBaseUrl}
                    onOpenClientKeysTab={() => setActiveTab('client-keys')}
                  />
                )}

                {/* Key 卡片网格 */}
                {dashboard.keys.length === 0 ? (
                  <section className="bg-white border border-dashed border-[#D6D2C8] rounded-2xl py-14 px-6 text-center">
                    <p className="text-sm font-medium text-[#1C1B18]">号池里还没有 Mistral API Key</p>
                    <p className="mt-1.5 text-xs text-[#78746B]">
                      点击下方按钮，一次性把你的多个 Mistral Key 粘贴导入并自动拉取剩余额度
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowAddModal(true)}
                      className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#E05A2B] hover:bg-[#C94B1F] text-white text-xs font-medium cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>立即批量导入 Key</span>
                    </button>
                  </section>
                ) : (
                  <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4">
                    {dashboard.keys.map((item) => (
                      <KeyCard
                        key={item.id}
                        item={item}
                        now={now}
                        probing={probingAll || probingKeyIds.has(item.id)}
                        onProbe={handleProbeSingle}
                        onToggleEnabled={handleToggleEnabled}
                        onResetStatus={handleResetStatus}
                        onEdit={setEditingKey}
                        onDelete={handleDelete}
                      />
                    ))}
                  </section>
                )}

                {/* 近期调用流水 */}
                <LogsPanel logs={logs} loading={loadingLogs} onRefresh={loadLogs} />
              </>
            ) : (
              <ClientKeysPanel
                clientKeys={dashboard.clientKeys}
                proxyBaseUrl={dashboard.proxyBaseUrl}
                hasEnvProxyKey={dashboard.hasEnvProxyKey}
                now={now}
                onChanged={(msg) => {
                  loadDashboard();
                  pushToast(msg);
                }}
                onError={(msg) => pushToast(msg, 'err')}
              />
            )}
          </>
        ) : (
          <div className="py-20 text-center text-xs text-[#78746B]">正在同步号池数据...</div>
        )}
      </main>

      {/* 各类弹窗 */}
      {showAddModal && (
        <AddKeyModal
          onClose={() => setShowAddModal(false)}
          onCompleted={(msg) => {
            setShowAddModal(false);
            loadDashboard();
            pushToast(msg);
          }}
        />
      )}

      {editingKey && (
        <EditKeyModal
          item={editingKey}
          onClose={() => setEditingKey(null)}
          onSaved={() => {
            setEditingKey(null);
            loadDashboard();
            pushToast('账号配置已更新');
          }}
        />
      )}

      {showPlayground && dashboard && (
        <PlaygroundModal
          keys={dashboard.keys}
          defaultModel={dashboard.settings.probe_model}
          onClose={() => setShowPlayground(false)}
          onAfterRun={() => {
            loadDashboard();
            loadLogs();
          }}
        />
      )}

      {/* 轻量底部 Toast 提示 */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl shadow-lg text-xs font-medium border max-w-[90vw] text-center bg-white border-[#E6E4DD] text-[#1C1B18]">
          <span className={toast.tone === 'err' ? 'text-[#B91C1C]' : 'text-[#15803D]'}>● </span>
          {toast.text}
        </div>
      )}
    </div>
  );
}
