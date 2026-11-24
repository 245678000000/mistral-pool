// 鉴权、恒定时间比对、网关客户端密钥生成与哈希、HMAC-SHA256 会话凭证与脱敏模块

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_COOKIE_NAME = 'mp_session';
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 默认 7 天有效

/** 将 API Key 脱敏，防止在前端或日志中泄露完整明文 */
export function maskApiKey(raw: string): string {
  const key = raw.trim();
  if (key.length >= 10) {
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
  }
  if (key.length >= 6) {
    return `${key.slice(0, 2)}••••${key.slice(-2)}`;
  }
  return '••••';
}

/** Base64URL 编码 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Base64URL 解码 */
function fromBase64Url(str: string): Uint8Array | null {
  try {
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** 生成高熵随机网关访问密钥（格式 mp-sk-<32位base64url>） */
export function generateClientApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `mp-sk-${toBase64Url(bytes)}`;
}

/** 生成客户端密钥的脱敏展示文本（如 mp-sk-AbCd••••wXyZ） */
export function formatClientKeyPrefix(rawKey: string): string {
  const key = rawKey.trim();
  if (key.startsWith('mp-sk-') && key.length >= 16) {
    return `${key.slice(0, 10)}••••${key.slice(-4)}`;
  }
  return maskApiKey(key);
}

/** 计算网关访问密钥的 SHA-256 十六进制哈希（数据库仅存哈希，不存明文） */
export async function hashClientKey(rawKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey.trim()));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** 从客户端请求头中提取访问令牌（兼容 Authorization: Bearer 与 x-api-key） */
export function extractProxyToken(
  authHeader: string | undefined,
  apiKeyHeader: string | undefined,
): string | null {
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }
  if (apiKeyHeader && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }
  return null;
}

/** 借助 SHA-256 定长摘要执行恒定时间字符串比对，防范时序攻击 */
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i += 1) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

/** 校验客户端请求携带的环境变量网关密钥（支持逗号分隔多密钥） */
export async function verifyBearerToken(
  authHeader: string | undefined,
  apiKeyHeader: string | undefined,
  configuredKeys: string | undefined,
): Promise<boolean> {
  if (!configuredKeys) return false;
  const token = extractProxyToken(authHeader, apiKeyHeader);
  if (!token) return false;

  const allowedKeys = configuredKeys
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const allowed of allowedKeys) {
    if (await timingSafeStringEqual(token, allowed)) {
      return true;
    }
  }
  return false;
}

/** 校验管理看板登录密码 */
export async function verifyAdminPassword(input: string, expected: string): Promise<boolean> {
  return timingSafeStringEqual(input, expected);
}

/** 导入 HMAC-SHA256 密钥 */
async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** 派生有效的会话签名密钥（优先使用显式配置的 SESSION_SECRET） */
export function resolveSessionSecret(sessionSecret: string | undefined, adminPassword: string): string {
  if (sessionSecret && sessionSecret.trim().length >= 16) {
    return sessionSecret.trim();
  }
  return `mistral-pool-derived-secret:${adminPassword}`;
}

/** 签发带过期时间的 HMAC-SHA256 会话令牌 */
export async function createSessionToken(
  secret: string,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  now = Date.now(),
): Promise<string> {
  const payload = JSON.stringify({
    exp: now + ttlSeconds * 1000,
    iat: now,
  });
  const payloadB64 = toBase64Url(encoder.encode(payload));
  const key = await importHmacKey(secret);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sigBuffer));
  return `${payloadB64}.${sigB64}`;
}

/** 验证会话令牌签名与过期时间 */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payloadB64, sigB64] = parts;
  const sigBytes = fromBase64Url(sigB64);
  const payloadBytes = fromBase64Url(payloadB64);
  if (!sigBytes || !payloadBytes) return false;

  try {
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(payloadB64));
    if (!valid) return false;

    const payload = JSON.parse(decoder.decode(payloadBytes)) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp > now;
  } catch {
    return false;
  }
}

/** 从 Cookie 请求头中解析指定名称的 Cookie 值 */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    if (key === name) {
      return decodeURIComponent(pair.slice(idx + 1).trim());
    }
  }
  return undefined;
}
