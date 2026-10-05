// src/lib/api.ts — 后端 API 封装
// ★ 安全约定：
//   - 所有写操作（POST/DELETE/PATCH）自动加 X-DM-Req: 1 头（CSRF 防护）
//   - 客户端只持有 JWT（登录凭证），不持有任何邮箱 token / 卡密 / API key
//   - 邮箱操作只传 id，地址由服务端解析
const BASE = '';

export interface Mailbox {
  id: string;
  address: string;          // 展示用（用户需要看自己邮箱地址才能发信过来）
  expires_at: string;
  created_at?: string;
  // ★ 注意：不再有 token 字段（服务端独占）
}

export interface Message {
  id: string;
  message_id?: string;
  from_address: string;
  from_name?: string;
  to_address: string;
  subject?: string;
  body_text?: string;
  body_html?: string;
  raw_size?: number;
  is_read: boolean | number;
  received_at: string;
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  filename?: string;
  content_type?: string;
  size?: number;
}

export interface Domain {
  id: string;
  domain: string;
  is_active: boolean | number;
  mx_synced: boolean | number;
  from_env?: boolean;      // 是否来自环境变量 ALLOWED_DOMAINS（自动同步，无需手动添加）
  created_at: string;
}

export interface Invitation {
  code: string;
  note: string | null;
  used_at: string | null;      // 首次使用时间
  last_used_at?: string | null;
  use_count?: number;
  expires_at: string;
  created_at: string;
  expired?: boolean;
  status?: 'unused' | 'used' | 'expired';
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(status ? `(${status}) ${message}` : message);
  }
}

/** 统一请求：写操作自动加 X-DM-Req 头 */
async function req(path: string, opts: RequestInit & { jwt?: string } = {}): Promise<any> {
  const { jwt, ...init } = opts;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (jwt) headers.set('Authorization', `Bearer ${jwt}`);
  // CSRF：非 GET 请求强制带 X-DM-Req 头
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('X-DM-Req', '1');
  }
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new ApiError(r.status, e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export const api = {
  // 公开
  health: () => req('/api/health'),
  // 用户认证：邀请码换 JWT
  exchange: (code: string) =>
    req('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code }) }) as Promise<{ token: string; expires_in: string; user_id_masked: string }>,
  me: (jwt: string) =>
    req('/api/me', { jwt }) as Promise<{ user_id_masked: string; mailboxes: Mailbox[] }>,
  adminLogin: (apiKey: string) =>
    req('/api/admin/login', { method: 'POST', body: JSON.stringify({ api_key: apiKey }) }) as Promise<{ token: string; expires_in: string }>,

  // 用户 JWT 鉴权 —— 全部用 id（地址由服务端解析）
  listMyMailboxes: (jwt: string) =>
    req('/api/mailboxes', { jwt }) as Promise<{ mailboxes: Mailbox[] }>,
  createMailbox: (jwt: string, body: { domain?: string; name?: string; ttl_hours?: number } = {}) =>
    req('/api/mailboxes', { method: 'POST', jwt, body: JSON.stringify(body) }) as Promise<Mailbox>,
  renewMailbox: (jwt: string, id: string) =>
    req(`/api/mailboxes/${encodeURIComponent(id)}/renew`, { method: 'POST', jwt }) as Promise<{ id: string; expires_at: string }>,
  getMailbox: (jwt: string, id: string) =>
    req(`/api/mailboxes/${encodeURIComponent(id)}`, { jwt }) as Promise<Mailbox & { messages: Message[] }>,
  deleteMailbox: (jwt: string, id: string) =>
    req(`/api/mailboxes/${encodeURIComponent(id)}`, { method: 'DELETE', jwt }),
  listMessages: (jwt: string, mailboxId: string) =>
    req(`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages`, { jwt }) as Promise<{ mailbox_id: string; messages: Message[] }>,
  getMessage: (jwt: string, id: string) =>
    req(`/api/messages/${encodeURIComponent(id)}`, { jwt }) as Promise<Message>,
  markRead: (jwt: string, id: string, isRead = true) =>
    req(`/api/messages/${encodeURIComponent(id)}`, { method: 'PATCH', jwt, body: JSON.stringify({ is_read: isRead }) }),
  deleteMessage: (jwt: string, id: string) =>
    req(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE', jwt }),
  // 附件下载（JWT 走 Authorization 头）
  downloadAttachment: async (jwt: string, id: string, filename: string): Promise<void> => {
    const r = await fetch(`${BASE}/api/attachments/${id}`, { headers: { Authorization: `Bearer ${jwt}` } });
    if (!r.ok) throw new ApiError(r.status, '下载失败');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // Admin JWT
  listDomains: (jwt: string) =>
    req('/api/admin/domains', { jwt }) as Promise<{ domains: Domain[] }>,
  addDomain: (jwt: string, domain: string) =>
    req('/api/admin/domains', { method: 'POST', jwt, body: JSON.stringify({ domain }) }),
  deleteDomain: (jwt: string, domain: string) =>
    req(`/api/admin/domains/${encodeURIComponent(domain)}`, { method: 'DELETE', jwt }),
  viewDns: (jwt: string, domain: string) =>
    req(`/api/admin/domains/${encodeURIComponent(domain)}/dns`, { jwt }) as Promise<{ domain: string; rrsets: any[] }>,
  syncDomain: (jwt: string, domain: string) =>
    req(`/api/admin/domains/${encodeURIComponent(domain)}/sync`, { method: 'POST', jwt }) as Promise<{ domain: string; mx_synced: boolean; error?: string }>,
  verifyDomain: (jwt: string, domain: string) =>
    req(`/api/admin/domains/${encodeURIComponent(domain)}/verify`, { jwt }) as Promise<{ domain: string; ok: boolean; records: string[] }>,
  cleanup: (jwt: string) =>
    req('/api/admin/cleanup', { method: 'POST', jwt }) as Promise<{ removed_mailboxes: number }>,

  // Admin 邀请码
  createInvitations: (jwt: string, body: { count?: number; note?: string; ttl_hours?: number }) =>
    req('/api/admin/invitations', { method: 'POST', jwt, body: JSON.stringify(body) }) as Promise<{ codes: string[]; count: number; ttl_hours: number; note: string }>,
  listInvitations: (jwt: string, status = 'all') =>
    req(`/api/admin/invitations?status=${status}`, { jwt }) as Promise<{ invitations: Invitation[] }>,
  deleteInvitation: (jwt: string, code: string) =>
    req(`/api/admin/invitations/${encodeURIComponent(code)}`, { method: 'DELETE', jwt }),
};

export { ApiError };
