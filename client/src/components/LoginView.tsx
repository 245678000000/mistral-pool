import { useState, type FormEvent } from 'react';
import { Lock, ArrowRight, ShieldCheck } from 'lucide-react';
import { adminApi, ApiError } from '../api';

interface LoginViewProps {
  onSuccess: () => void;
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setError('请输入管理员密码');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await adminApi.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm bg-white border border-[#E6E4DD] rounded-2xl shadow-[0_8px_30px_rgba(28,27,24,0.06)] p-7">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-[#E05A2B] flex items-center justify-center text-white font-bold text-lg shadow-sm">
            M
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-[#1C1B18]">Mistral Pool</h1>
            <p className="text-xs text-[#6B6860]">多号池聚合网关与额度看板</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="admin-password" className="block text-xs font-medium text-[#57534E] mb-1.5">
              管理员密码
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-[#9C978D] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                id="admin-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入 ADMIN_PASSWORD 登录"
                className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-[#FAFAF8] border border-[#DFDDD5] rounded-xl focus:outline-none focus:border-[#E05A2B] focus:bg-white transition-colors"
              />
            </div>
          </div>

          {error && (
            <div className="text-xs text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#E05A2B] hover:bg-[#C94B1F] disabled:opacity-60 text-white text-sm font-medium transition-colors cursor-pointer"
          >
            <span>{loading ? '正在验证...' : '进入管理看板'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-[#EFECE6] flex items-center gap-2 text-[11px] text-[#78746B]">
          <ShieldCheck className="w-3.5 h-3.5 text-[#15803D] shrink-0" />
          <span>代理接口（/v1/*）使用独立网关密钥，与看板登录完全隔离</span>
        </div>
      </div>
    </div>
  );
}
