import { useState, type FormEvent } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  Power,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { adminApi, ApiError, formatClock, formatRelativeTime, formatTokens } from '../api';
import type { ClientKeyView } from '../types';

interface ClientKeysPanelProps {
  clientKeys: ClientKeyView[];
  proxyBaseUrl: string;
  hasEnvProxyKey: boolean;
  now: number;
  onChanged: (toastText: string) => void;
  onError: (errText: string) => void;
}

export function ClientKeysPanel({
  clientKeys,
  proxyBaseUrl,
  hasEnvProxyKey,
  now,
  onChanged,
  onError,
}: ClientKeysPanelProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdResult, setCreatedResult] = useState<{ name: string; plaintextKey: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const [renamingItem, setRenamingItem] = useState<ClientKeyView | null>(null);
  const [renameText, setRenameText] = useState('');
  const [renaming, setRenaming] = useState(false);

  const openCreateModal = () => {
    setNewKeyName('');
    setCreatedResult(null);
    setCopiedKey(false);
    setCopiedUrl(false);
    setShowCreateModal(true);
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await adminApi.createClientKey(newKeyName.trim());
      setCreatedResult({ name: res.clientKey.name, plaintextKey: res.plaintextKey });
      onChanged(`已创建网关密钥「${res.clientKey.name}」`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : '创建密钥失败');
    } finally {
      setCreating(false);
    }
  };

  const handleCopyText = async (text: string, which: 'key' | 'url') => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'key') {
        setCopiedKey(true);
        window.setTimeout(() => setCopiedKey(false), 1800);
      } else {
        setCopiedUrl(true);
        window.setTimeout(() => setCopiedUrl(false), 1800);
      }
    } catch {
      onError('剪贴板复制失败，请手动选中复制');
    }
  };

  const handleToggle = async (item: ClientKeyView) => {
    try {
      await adminApi.updateClientKey(item.id, { enabled: !item.enabled });
      onChanged(`密钥「${item.name}」已${item.enabled ? '停用' : '启用'}`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : '更新状态失败');
    }
  };

  const handleRenameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!renamingItem || !renameText.trim()) return;
    setRenaming(true);
    try {
      await adminApi.updateClientKey(renamingItem.id, { name: renameText.trim() });
      setRenamingItem(null);
      onChanged('网关密钥名称已更新');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : '改名失败');
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async (item: ClientKeyView) => {
    if (
      !window.confirm(
        `确定要彻底删除网关密钥「${item.name}」（${item.key_prefix}）吗？\n删除后使用该密钥的客户端将立即无法访问网关。`,
      )
    ) {
      return;
    }
    try {
      await adminApi.deleteClientKey(item.id);
      onChanged(`已删除并吊销密钥「${item.name}」`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : '删除失败');
    }
  };

  return (
    <div className="space-y-4">
      {/* 顶部说明与操作条 */}
      <section className="bg-white border border-[#E6E4DD] rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#E05A2B]" />
            <h2 className="text-base font-semibold text-[#1C1B18]">网关访问密钥（Client API Keys）</h2>
          </div>
          <p className="text-xs text-[#6B6860] leading-relaxed">
            为你的手机、电脑客户端或合作成员生成独立的访问密钥（填到客户端的 API Key 栏）。数据库仅保存 SHA-256 哈希，随时可单把停用或删除吊销。
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateModal}
          className="shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#E05A2B] hover:bg-[#C94B1F] text-white text-xs font-medium shadow-xs transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>创建新 API Key</span>
        </button>
      </section>

      {/* 环境变量兜底状态提示 */}
      {hasEnvProxyKey && (
        <div className="rounded-xl bg-[#FAF9F6] border border-[#E6E4DD] px-4 py-2.5 flex items-center gap-2 text-xs text-[#57534E]">
          <ShieldCheck className="w-4 h-4 text-[#15803D] shrink-0" />
          <span>
            当前环境变量 <code className="font-mono bg-white px-1 py-0.5 rounded border border-[#E6E4DD]">PROXY_API_KEY</code> 处于启用状态，与下方网页创建的密钥同时有效（向下兼容）。
          </span>
        </div>
      )}

      {/* 密钥列表 */}
      {clientKeys.length === 0 ? (
        <section className="bg-white border border-dashed border-[#D6D2C8] rounded-2xl py-14 px-6 text-center">
          <KeyRound className="w-8 h-8 text-[#C5C0B5] mx-auto mb-3" />
          <p className="text-sm font-medium text-[#1C1B18]">还没有在看板中创建过网关 API Key</p>
          <p className="mt-1.5 text-xs text-[#78746B]">
            点击下方按钮生成一把专属密钥，复制填入你的 AI 客户端即可连接整个 Mistral 号池
          </p>
          <button
            type="button"
            onClick={openCreateModal}
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#E05A2B] hover:bg-[#C94B1F] text-white text-xs font-medium cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>立即创建第一把 API Key</span>
          </button>
        </section>
      ) : (
        <section className="bg-white border border-[#E6E4DD] rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <thead className="bg-[#FAF9F6] text-[11px] text-[#6B6860] border-b border-[#EFECE6]">
                <tr>
                  <th className="py-3 px-4 font-medium">名称</th>
                  <th className="py-3 px-3 font-medium">密钥（已脱敏）</th>
                  <th className="py-3 px-3 font-medium">状态</th>
                  <th className="py-3 px-3 font-medium text-right">累计调用</th>
                  <th className="py-3 px-3 font-medium text-right">累计消耗</th>
                  <th className="py-3 px-3 font-medium">最近使用</th>
                  <th className="py-3 px-3 font-medium">创建时间</th>
                  <th className="py-3 px-4 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F2EFE9] tabular-nums">
                {clientKeys.map((item) => (
                  <tr key={item.id} className={item.enabled ? 'hover:bg-[#FCFBF9]' : 'opacity-65 bg-[#FAF9F6]'}>
                    <td className="py-3 px-4 font-medium text-[#1C1B18]">{item.name}</td>
                    <td className="py-3 px-3">
                      <code className="font-mono text-[11px] bg-[#F5F4F0] px-2 py-0.5 rounded text-[#57534E]">
                        {item.key_prefix}
                      </code>
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                          item.enabled
                            ? 'bg-[#ECFDF3] text-[#15803D] border-[#BBF7D0]'
                            : 'bg-[#F3F2EE] text-[#6B6860] border-[#E2DFD7]'
                        }`}
                      >
                        {item.enabled ? '生效中' : '已停用'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right text-[#1C1B18]">{item.total_requests} 次</td>
                    <td className="py-3 px-3 text-right text-[#1C1B18]">{formatTokens(item.total_tokens)}</td>
                    <td className="py-3 px-3 text-[#78746B]">{formatRelativeTime(item.last_used_at, now)}</td>
                    <td className="py-3 px-3 text-[#8A857C]">{formatClock(item.created_at)}</td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleToggle(item)}
                          title={item.enabled ? '停用此密钥' : '重新启用此密钥'}
                          className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                            item.enabled
                              ? 'text-[#15803D] hover:bg-[#ECFDF3]'
                              : 'text-[#9C978D] hover:bg-[#EAE7DF]'
                          }`}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingItem(item);
                            setRenameText(item.name);
                          }}
                          title="修改名称"
                          className="p-1.5 rounded-lg text-[#6B6860] hover:text-[#1C1B18] hover:bg-[#F5F4F0] cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(item)}
                          title="删除并立即吊销"
                          className="p-1.5 rounded-lg text-[#9C978D] hover:text-[#B91C1C] hover:bg-[#FEF2F2] cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 创建新网关 API Key 弹窗（含一次性明文展示与一键复制） */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white border border-[#E6E4DD] rounded-2xl shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[#EFECE6] flex items-center justify-between">
              <h3 className="text-base font-semibold text-[#1C1B18]">
                {createdResult ? '密钥已生成，请立即复制保存' : '创建新的网关 API Key'}
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded-lg text-[#78746B] hover:bg-[#F5F4F0] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {!createdResult ? (
              <form onSubmit={handleCreate} className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-[#57534E] mb-1.5">
                    密钥名称 / 用途标识
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="例如：iPhone 客户端 / Cherry Studio / 备用电脑"
                    className="w-full px-3 py-2 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white"
                  />
                  <p className="mt-1.5 text-[11px] text-[#78746B]">
                    留空将自动按序号命名；给不同设备建独立密钥方便后续按设备追踪用量和单独吊销。
                  </p>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 rounded-xl text-xs font-medium text-[#57534E] hover:bg-[#F5F4F0] cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="px-4 py-2 rounded-xl text-xs font-medium bg-[#E05A2B] hover:bg-[#C94B1F] disabled:opacity-60 text-white cursor-pointer"
                  >
                    {creating ? '生成中...' : '生成 API Key'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="p-5 space-y-4">
                <div className="rounded-xl bg-[#FFFBEB] border border-[#FDE68A] p-3 flex items-start gap-2 text-xs text-[#92400E]">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-[#D97706]" />
                  <span>
                    出于安全考虑，系统只保存此密钥的加密哈希。<strong>关闭本窗口后将无法再次查看完整明文</strong>，如果遗失请删除后重新创建。
                  </span>
                </div>

                <div className="space-y-2.5">
                  <div>
                    <div className="text-[11px] text-[#78746B] mb-1">API Key（{createdResult.name}）</div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 font-mono text-xs bg-[#FAF9F6] border border-[#DFDDD5] rounded-xl px-3 py-2.5 text-[#1C1B18] break-all select-all">
                        {createdResult.plaintextKey}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopyText(createdResult.plaintextKey, 'key')}
                        className="shrink-0 inline-flex items-center gap-1 px-3 py-2.5 rounded-xl bg-[#E05A2B] hover:bg-[#C94B1F] text-white text-xs font-medium cursor-pointer"
                      >
                        {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedKey ? '已复制' : '复制'}</span>
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] text-[#78746B] mb-1">客户端接口地址（Base URL）</div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 font-mono text-xs bg-[#FAF9F6] border border-[#EFECE6] rounded-xl px-3 py-2 text-[#57534E] truncate">
                        {proxyBaseUrl}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopyText(proxyBaseUrl, 'url')}
                        className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-white border border-[#DFDDD5] hover:border-[#C5C0B5] text-xs text-[#1C1B18] cursor-pointer"
                      >
                        {copiedUrl ? <Check className="w-3.5 h-3.5 text-[#15803D]" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedUrl ? '已复制' : '复制'}</span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 rounded-xl text-xs font-medium bg-[#1C1B18] hover:bg-[#33312C] text-white cursor-pointer"
                  >
                    我已复制保存，关闭
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 重命名弹窗 */}
      {renamingItem && (
        <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-white border border-[#E6E4DD] rounded-2xl shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[#EFECE6] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#1C1B18]">重命名网关密钥</h3>
              <button
                type="button"
                onClick={() => setRenamingItem(null)}
                className="p-1 rounded-lg text-[#78746B] hover:bg-[#F5F4F0] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleRenameSubmit} className="p-5 space-y-4">
              <input
                type="text"
                autoFocus
                value={renameText}
                onChange={(e) => setRenameText(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRenamingItem(null)}
                  className="px-3.5 py-2 rounded-xl text-xs text-[#57534E] hover:bg-[#F5F4F0] cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={renaming || !renameText.trim()}
                  className="px-3.5 py-2 rounded-xl text-xs font-medium bg-[#E05A2B] hover:bg-[#C94B1F] disabled:opacity-60 text-white cursor-pointer"
                >
                  {renaming ? '保存中...' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
