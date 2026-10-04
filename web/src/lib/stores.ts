// src/lib/stores.ts — 全局状态
import { writable, type Writable } from 'svelte/store';
import type { Mailbox, Domain, Invitation } from './api';

// ===== 用户态（终端用户：邀请码换 JWT） =====
// ★ 只持有 JWT 和脱敏的 user_id_masked；不保存完整邀请码
interface UserState {
  jwt: string | null;
  userIdMasked: string | null;   // 脱敏标识（前 8 位 + …）
  mailboxes: Mailbox[];          // 该用户的所有邮箱（不含 token）
}

export const userStore: Writable<UserState> = writable({
  jwt: null,
  userIdMasked: null,
  mailboxes: [],
});

// ===== 管理员态 =====
interface AdminState {
  jwt: string | null;
  domains: Domain[];
  invitations: Invitation[];
}

export const adminStore: Writable<AdminState> = writable({
  jwt: null,
  domains: [],
  invitations: [],
});

// ===== Toast 通知 =====
export interface Toast {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error';
}
export const toasts: Writable<Toast[]> = writable([]);

export function toast(message: string, type: Toast['type'] = 'info') {
  const id = Date.now() + Math.random();
  toasts.update((t) => [...t, { id, message, type }]);
  setTimeout(() => toasts.update((t) => t.filter((x) => x.id !== id)), 3500);
}

// ===== localStorage 持久化 =====
const USER_KEY = 'tempmail_user';        // {jwt, userIdMasked}
const ADMIN_KEY = 'tempmail_admin_jwt';

export function loadUser(): { jwt: string; userIdMasked: string } | null {
  const saved = localStorage.getItem(USER_KEY);
  if (!saved) return null;
  try {
    const v = JSON.parse(saved);
    if (v?.jwt && v?.userIdMasked) {
      userStore.set({ jwt: v.jwt, userIdMasked: v.userIdMasked, mailboxes: [] });
      return v;
    }
  } catch {}
  return null;
}

export function saveUser(u: { jwt: string; userIdMasked: string } | null): void {
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_KEY);
}

export function clearUser(): void {
  saveUser(null);
  userStore.set({ jwt: null, userIdMasked: null, mailboxes: [] });
}

export function loadAdmin(): string | null {
  return localStorage.getItem(ADMIN_KEY);
}

export function saveAdmin(jwt: string | null): void {
  if (jwt) localStorage.setItem(ADMIN_KEY, jwt);
  else localStorage.removeItem(ADMIN_KEY);
}
