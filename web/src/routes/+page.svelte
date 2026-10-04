<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError, type Message, type Mailbox } from '$lib/api';
  import { userStore, loadUser, saveUser, clearUser, toast } from '$lib/stores';
  import Icon from '$lib/components/Icon.svelte';
  import Toasts from '$lib/components/Toasts.svelte';

  // 用户登录态
  const u = $userStore;
  let bootstrapped = $state(false);

  // 视图层级：邮箱列表 → 邮箱详情（收件箱 → 邮件详情）
  let activeMailbox = $state<Mailbox | null>(null);   // 当前选中的邮箱
  let messages = $state<Message[]>([]);
  let selectedMessage = $state<Message | null>(null);
  let selectedId = $state<string | null>(null);
  let loadingDetail = $state(false);
  let loadingMailboxes = $state(false);
  let loadingMessages = $state(false);
  let now = $state(Date.now());

  // 创建邮箱对话框
  let showCreate = $state(false);
  let newName = $state('');
  let creating = $state(false);

  // WebSocket 实时推送（按当前邮箱订阅）
  let wsConnected = $state(false);
  let ws: WebSocket | null = null;
  let wsRetry = 0;
  let disposed = false;

  // 头像配色
  const avatarColors = [
    'bg-primary-container text-primary-onContainer',
    'bg-tertiary-container text-tertiary-onContainer',
    'bg-secondary-container text-secondary-onContainer',
    'bg-error-container text-error-onContainer',
    'bg-success-container text-success',
  ];
  function avatarColor(addr: string): string {
    let h = 0;
    for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
    return avatarColors[h % avatarColors.length];
  }
  function initial(addr: string): string {
    return (addr?.[0] || '?').toUpperCase();
  }

  // 时间格式化（SQLite CURRENT_TIMESTAMP 是空格分隔的 UTC，Safari 不认）
  function parseDbDate(iso: string): Date {
    const norm = iso.includes('T') ? iso : iso.replace(' ', 'T');
    return new Date(norm.endsWith('Z') ? norm : `${norm}Z`);
  }
  function fmtTime(iso: string): string {
    const d = parseDbDate(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }
  function fmtFull(iso: string): string {
    return parseDbDate(iso).toLocaleString('zh-CN');
  }
  function fmtTtl(iso: string): string {
    const ms = parseDbDate(iso).getTime() - now;
    if (ms <= 0) return '已过期';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  function isExpired(iso: string): boolean {
    return parseDbDate(iso).getTime() <= now;
  }
  function fmtSize(b?: number): string {
    if (!b) return '';
    return b > 1024 ? `${Math.round(b / 1024 * 10) / 10} KB` : `${b} B`;
  }
  const esc = (s?: string) => (s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));

  // ===== 邮件正文 / Magic Link / OTP 提取 =====
  function textOf(m?: Message | null): string {
    if (!m) return '';
    if (m.body_text) return m.body_text;
    if (!m.body_html) return '';
    return m.body_html
      .replace(/<a\s[^>]*href=("|')([^"']+)("|')[^>]*>/gi, ' $2 ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }

  function extractMagicLink(m?: Message | null): string | null {
    const text = textOf(m);
    if (!text) return null;
    const urls = text.match(/https?:\/\/[^\s)<>"'\]]+/gi) ?? [];
    const junkUrl = /\/ls\/click|\bupn=|unsubscribe|opt-?out|\/privacy|\/terms\b|\/help\b|support@|mailto:|\/preferences|\/legal\b|\/policy/i;
    const junkHost = /^url\d+\.|(^|\.)(mail|email|mailer|sendgrid|mailgun|mandrill|mc)\./i;
    const actionPath = /magic|sign-?in|log-?in|login|auth|verify|verification|confirm|activate|invite|reset|one-?time|token|callback|continue/i;
    const contextHint = /sign|log ?in|magic|verify|confirm|activate|登录|登入|点击|click|button|finish|complete/i;

    let best: { url: string; score: number } | null = null;
    for (const raw of urls) {
      const url = raw.replace(/[.,;:!?'"]+$/, '');
      if (junkUrl.test(url)) continue;
      let host = '';
      try { host = new URL(url).hostname; } catch { continue; }
      if (junkHost.test(host)) continue;
      let score = 0;
      if (actionPath.test(url)) score += 5;
      const idx = text.indexOf(raw);
      const around = text.slice(Math.max(0, idx - 100), idx + raw.length + 40);
      if (contextHint.test(around)) score += 3;
      if (score >= 5 && (!best || score > best.score)) best = { url, score };
    }
    return best?.url ?? null;
  }

  function extractOtp(m?: Message | null): string | null {
    const text = textOf(m);
    if (!text) return null;
    const ctx = text.match(/(?:验证码|code|otp|verification|密码)[^\d]{0,60}?(\d{3}[-–—\s]\d{3}|\d{4,8})\b/i);
    if (ctx) return ctx[1];
    const alone = text.match(/(?:^|\n)\s*(\d{3}[-–—]\d{3}|\d{4,8})\s*(?:\n|$)/);
    if (alone) return alone[1];
    if (!extractMagicLink(m)) {
      return text.match(/\b(\d{4,8})\b/)?.[1] ?? null;
    }
    return null;
  }

  let otp = $derived(extractOtp(selectedMessage));
  let magicLink = $derived(extractMagicLink(selectedMessage));
  let viewMode = $state<'text' | 'html'>('text');
  const canToggle = $derived(!!selectedMessage?.body_text && !!selectedMessage?.body_html);

  // ===== 生命周期 =====
  onMount(() => {
    const saved = loadUser();
    if (!saved) {
      goto('/login');
      return;
    }
    bootstrapped = true;
    void loadMailboxes();
    const ttl = setInterval(() => (now = Date.now()), 1000);
    return () => { disposed = true; clearInterval(ttl); ws?.close(); };
  });

  // ===== 邮箱列表 =====
  async function loadMailboxes() {
    if (!u.jwt) return;
    loadingMailboxes = true;
    try {
      const r = await api.listMyMailboxes(u.jwt);
      userStore.update((s) => ({ ...s, mailboxes: r.mailboxes }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearUser();
        toast('登录已过期，请重新登录', 'error');
        goto('/login');
      } else {
        toast(`加载失败：${e instanceof Error ? e.message : ''}`, 'error');
      }
    } finally {
      loadingMailboxes = false;
    }
  }

  async function createMailbox() {
    if (!u.jwt) return;
    creating = true;
    try {
      const mb = await api.createMailbox(u.jwt, newName.trim() ? { name: newName.trim() } : {});
      userStore.update((s) => ({ ...s, mailboxes: [mb, ...s.mailboxes] }));
      showCreate = false;
      newName = '';
      toast('已创建临时邮箱', 'success');
      // 自动进入新邮箱
      void openMailbox(mb);
    } catch (e) {
      toast(`创建失败：${e instanceof Error ? e.message : ''}`, 'error');
    } finally {
      creating = false;
    }
  }

  async function renewMailbox(mb: Mailbox) {
    if (!u.jwt) return;
    try {
      const r = await api.renewMailbox(u.jwt, mb.id);
      userStore.update((s) => ({
        ...s,
        mailboxes: s.mailboxes.map((m) => (m.id === mb.id ? { ...m, expires_at: r.expires_at } : m)),
      }));
      if (activeMailbox?.id === mb.id) activeMailbox = { ...activeMailbox, expires_at: r.expires_at };
      toast('已续期', 'success');
    } catch (e) {
      toast(`续期失败：${e instanceof Error ? e.message : ''}`, 'error');
    }
  }

  async function deleteMailbox(mb: Mailbox) {
    if (!u.jwt || !confirm(`删除邮箱 ${mb.address} 及其全部邮件？此操作不可恢复。`)) return;
    try {
      await api.deleteMailbox(u.jwt, mb.id);
      userStore.update((s) => ({ ...s, mailboxes: s.mailboxes.filter((m) => m.id !== mb.id) }));
      if (activeMailbox?.id === mb.id) {
        closeWs();
        activeMailbox = null;
        messages = [];
        selectedMessage = null;
        selectedId = null;
      }
      toast('邮箱已删除', 'success');
    } catch (e) {
      toast(`删除失败：${e instanceof Error ? e.message : ''}`, 'error');
    }
  }

  // ===== 进入某个邮箱 → 拉邮件列表 + 订阅 WS =====
  async function openMailbox(mb: Mailbox) {
    if (isExpired(mb.expires_at)) {
      toast('该邮箱已过期，无法收信（可续期后恢复）', 'error');
    }
    activeMailbox = mb;
    selectedMessage = null;
    selectedId = null;
    await loadMessages();
    connectWs();
  }

  function backToMailboxes() {
    closeWs();
    activeMailbox = null;
    messages = [];
    selectedMessage = null;
    selectedId = null;
  }

  async function loadMessages() {
    if (!u.jwt || !activeMailbox) return;
    loadingMessages = true;
    try {
      const r = await api.listMessages(u.jwt, activeMailbox.id);
      messages = r.messages;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearUser();
        toast('登录已过期', 'error');
        goto('/login');
      }
    } finally {
      loadingMessages = false;
    }
  }

  function connectWs() {
    if (!u.jwt || !activeMailbox || ws) return;
    // ★ WS 改用 user JWT 鉴权（不再泄露 mailbox token）；服务端按 userId 推送该用户所有邮箱的新邮件
    ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws?token=${u.jwt}`);
    ws.onopen = () => { wsConnected = true; wsRetry = 0; };
    ws.onclose = () => {
      wsConnected = false;
      ws = null;
      if (!disposed && activeMailbox) {
        const delay = Math.min(30000, 1000 * 2 ** wsRetry++);
        setTimeout(() => { if (!disposed && activeMailbox && !ws) connectWs(); }, delay);
      }
    };
    ws.onerror = () => { wsConnected = false; };
    ws.onmessage = async () => {
      await loadMessages();
      toast('收到新邮件', 'success');
    };
  }

  function closeWs() {
    ws?.close();
    ws = null;
    wsConnected = false;
  }

  // ===== 邮件详情 =====
  async function openMessage(id: string) {
    if (!u.jwt) return;
    selectedId = id;
    loadingDetail = true;
    selectedMessage = null;
    try {
      selectedMessage = await api.getMessage(u.jwt, id);
      viewMode = selectedMessage.body_text ? 'text' : 'html';
      if (!selectedMessage.is_read) {
        await api.markRead(u.jwt, id, true).catch(() => {});
        messages = messages.map((m) => (m.id === id ? { ...m, is_read: true as any } : m));
      }
    } catch (e) {
      toast(`加载失败：${e instanceof Error ? e.message : ''}`, 'error');
      selectedId = null;
    } finally {
      loadingDetail = false;
    }
  }

  async function deleteMessage() {
    if (!u.jwt || !selectedId || !confirm('删除这封邮件？')) return;
    try {
      await api.deleteMessage(u.jwt, selectedId);
      messages = messages.filter((m) => m.id !== selectedId);
      selectedMessage = null;
      selectedId = null;
      toast('邮件已删除', 'success');
    } catch (e) {
      toast(`删除失败：${e instanceof Error ? e.message : ''}`, 'error');
    }
  }

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制`, 'success');
  }

  function logout() {
    closeWs();
    clearUser();
    goto('/login');
  }
</script>

<!-- 全屏布局：dvh 适配移动端地址栏，safe-area 适配刘海屏 -->
<div class="h-screen supports-[height:100dvh]:h-dvh flex flex-col bg-surface pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
  <!-- 顶部应用栏 -->
  <header class="h-16 px-4 sm:px-6 flex items-center justify-between border-b border-surface-variant bg-surface-container shrink-0">
    <div class="flex items-center gap-3 min-w-0">
      <div class="w-9 h-9 rounded-m3sm bg-primary flex items-center justify-center shadow-m1 shrink-0">
        <Icon name="mail" class="text-primary-on" size={22} fill />
      </div>
      <div class="min-w-0">
        <h1 class="text-base font-semibold text-surface-on leading-tight">TempMail</h1>
        <p class="text-[11px] text-surface-on-variant leading-tight truncate">自托管临时邮箱</p>
      </div>
    </div>
    <div class="flex items-center gap-1">
      {#if activeMailbox}
        <button class="btn btn-text btn-sm md:hidden" onclick={backToMailboxes}>
          <Icon name="arrow_back" size={18} /> 邮箱
        </button>
      {/if}
      <a href="/admin" class="btn btn-text btn-sm" title="管理后台">
        <Icon name="admin_panel_settings" size={18} />
        <span class="hidden sm:inline">管理</span>
      </a>
      {#if u.userIdMasked}
        <span class="chip chip-neutral hidden sm:inline-flex" title={u.userIdMasked}>
          <Icon name="vpn_key" size={13} /> {u.userIdMasked}
        </span>
      {/if}
      <button class="btn btn-text btn-sm" onclick={logout} title="退出登录">
        <Icon name="logout" size={18} />
        <span class="hidden sm:inline">退出</span>
      </button>
    </div>
  </header>

  {#if !bootstrapped}
    <div class="flex-1 flex items-center justify-center">
      <Icon name="progress_activity" size={32} class="text-primary animate-spin" />
    </div>
  {:else if !activeMailbox}
    <!-- 第一层：邮箱列表 -->
    <div class="flex-1 overflow-y-auto scroll-area">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 py-6">
        <div class="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h2 class="text-xl font-semibold text-surface-on">我的邮箱</h2>
            <p class="text-sm text-surface-on-variant mt-0.5">
              共 {u.mailboxes.length} 个邮箱
              {#if u.mailboxes.filter(m => !isExpired(m.expires_at)).length !== u.mailboxes.length}
                · <span class="text-error">{u.mailboxes.filter(m => isExpired(m.expires_at)).length} 已过期</span>
              {/if}
            </p>
          </div>
          <button class="btn btn-filled" onclick={() => (showCreate = true)}>
            <Icon name="add" size={18} /> 创建邮箱
          </button>
        </div>

        {#if loadingMailboxes && u.mailboxes.length === 0}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {#each Array(6) as _}
              <div class="card p-4">
                <div class="skeleton h-4 w-3/4 mb-3"></div>
                <div class="skeleton h-3 w-1/2"></div>
              </div>
            {/each}
          </div>
        {:else if u.mailboxes.length === 0}
          <div class="text-center py-16 px-4 animate-fade-in">
            <div class="w-20 h-20 rounded-m3lg bg-primary-container mx-auto flex items-center justify-center mb-5 shadow-m1">
              <Icon name="mark_email_unread" class="text-primary-onContainer" size={48} fill />
            </div>
            <h3 class="text-lg font-semibold text-surface-on mb-2">还没有邮箱</h3>
            <p class="text-sm text-surface-on-variant mb-6">创建一个临时邮箱，即时接收邮件与验证码</p>
            <button class="btn btn-filled" onclick={() => (showCreate = true)}>
              <Icon name="add" size={18} /> 创建第一个邮箱
            </button>
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {#each u.mailboxes as mb (mb.id)}
              <div class="card p-4 flex flex-col gap-3 animate-fade-in">
                <div class="flex items-start gap-3">
                  <div class="avatar {avatarColor(mb.address)} shrink-0">{initial(mb.address)}</div>
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-semibold text-surface-on truncate" title={mb.address}>{esc(mb.address)}</div>
                    <div class="text-xs text-outline mt-0.5">创建于 {fmtTime(mb.created_at || mb.expires_at)}</div>
                  </div>
                  {#if isExpired(mb.expires_at)}
                    <span class="chip chip-error text-[10px] h-5 shrink-0">已过期</span>
                  {:else}
                    <span class="chip chip-success text-[10px] h-5 shrink-0">
                      <span class="w-1.5 h-1.5 rounded-full bg-success"></span>
                      {fmtTtl(mb.expires_at)}
                    </span>
                  {/if}
                </div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <button class="btn btn-tonal btn-sm flex-1 min-w-[80px]" onclick={() => openMailbox(mb)}>
                    <Icon name="inbox" size={14} /> 进入
                  </button>
                  <button class="btn btn-outlined btn-sm" onclick={() => copy(mb.address, '邮箱地址')} title="复制地址">
                    <Icon name="content_copy" size={14} />
                  </button>
                  <button class="btn btn-outlined btn-sm" onclick={() => renewMailbox(mb)} title="续期" disabled={!isExpired(mb.expires_at) && parseDbDate(mb.expires_at).getTime() - now > 3600000}>
                    <Icon name="refresh" size={14} />
                  </button>
                  <button class="btn btn-danger btn-sm" onclick={() => deleteMailbox(mb)} title="删除">
                    <Icon name="delete" size={14} />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <!-- 第二层：邮箱详情（收件箱 + 邮件详情双栏） -->
    <!-- 邮箱信息条 -->
    <div class="px-4 sm:px-6 py-3 bg-surface-container-low border-b border-surface-variant shrink-0">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-2 min-w-0">
          <Icon name="alternate_email" class="text-primary shrink-0" size={20} />
          <span class="font-medium text-surface-on truncate">{activeMailbox.address}</span>
          {#if isExpired(activeMailbox.expires_at)}
            <span class="chip chip-error text-[10px] h-5">已过期</span>
          {/if}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="chip {wsConnected ? 'chip-success' : 'chip-neutral'}">
            <span class="w-1.5 h-1.5 rounded-full {wsConnected ? 'bg-success' : 'bg-outline'} {wsConnected ? 'animate-pulse' : ''}"></span>
            {wsConnected ? '实时' : '轮询'}
          </span>
          <span class="chip chip-primary">
            <Icon name="schedule" size={13} />
            {fmtTtl(activeMailbox.expires_at)}
          </span>
          <button class="btn btn-tonal btn-sm" onclick={() => activeMailbox && renewMailbox(activeMailbox)} title="续期">
            <Icon name="refresh" size={14} /> 续期
          </button>
          <button class="btn btn-text btn-sm" onclick={() => copy(activeMailbox!.address, '邮箱地址')} title="复制地址">
            <Icon name="content_copy" size={14} />
          </button>
        </div>
      </div>
    </div>

    <!-- 主体双栏 -->
    <div class="flex-1 flex overflow-hidden">
      <!-- 左：邮件列表 -->
      <aside class="w-full md:w-[380px] lg:w-[420px] border-r border-surface-variant bg-surface-container-low flex flex-col shrink-0 {selectedId ? 'hidden md:flex' : ''}">
        <div class="px-4 py-3 flex items-center justify-between shrink-0">
          <h2 class="text-sm font-semibold text-surface-on flex items-center gap-2">
            <Icon name="inbox" class="text-primary" size={18} />
            收件箱
            <span class="text-xs font-normal text-surface-on-variant">({messages.length})</span>
          </h2>
          <div class="flex items-center gap-1">
            <button class="btn btn-text btn-sm md:hidden" onclick={backToMailboxes} title="返回邮箱列表">
              <Icon name="arrow_back" size={16} />
            </button>
            <button class="btn btn-text btn-sm" onclick={loadMessages} title="刷新" disabled={loadingMessages}>
              <Icon name="refresh" size={16} class={loadingMessages ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto scroll-area px-2 pb-2">
          {#if loadingMessages && messages.length === 0}
            {#each Array(5) as _, i}
              <div class="flex items-start gap-3 p-3">
                <div class="skeleton w-10 h-10 rounded-full"></div>
                <div class="flex-1 space-y-2">
                  <div class="skeleton h-3 w-3/4"></div>
                  <div class="skeleton h-3 w-1/2"></div>
                </div>
              </div>
            {/each}
          {:else if messages.length === 0}
            <div class="text-center py-16 px-4">
              <Icon name="inbox" size={48} class="text-outline mx-auto mb-3 opacity-50" />
              <p class="text-sm text-surface-on-variant">暂无邮件</p>
              <p class="text-xs text-outline mt-1">等待接收中…</p>
            </div>
          {:else}
            {#each messages as m (m.id)}
              <button
                class="mail-item w-full text-left {selectedId === m.id ? 'active' : ''}"
                onclick={() => openMessage(m.id)}
              >
                <div class="avatar {avatarColor(m.from_address)}">{initial(m.from_address)}</div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-sm font-medium truncate {m.is_read ? 'text-surface-on-variant' : 'text-surface-on'}">{esc(m.from_address)}</span>
                    <span class="text-[11px] text-outline shrink-0">{fmtTime(m.received_at)}</span>
                  </div>
                  <div class="text-sm truncate mt-0.5 {m.is_read ? 'text-surface-on-variant' : 'text-surface-on font-medium'}">{esc(m.subject) || '(无主题)'}</div>
                  <div class="text-xs text-outline truncate mt-0.5">{esc(m.body_text?.slice(0, 60)) || '(空)'}</div>
                </div>
                {#if !m.is_read}
                  <span class="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5"></span>
                {/if}
              </button>
            {/each}
          {/if}
        </div>
      </aside>

      <!-- 右：邮件详情 -->
      <main class="flex-1 overflow-hidden {selectedId ? 'flex flex-col' : 'hidden md:block'}">
        {#if !selectedId}
          <div class="h-full flex items-center justify-center p-6">
            <div class="text-center">
              <Icon name="drafts" size={64} class="text-outline mx-auto mb-4 opacity-40" />
              <p class="text-sm text-surface-on-variant">从左侧选择一封邮件查看详情</p>
            </div>
          </div>
        {:else if loadingDetail}
          <div class="h-full flex items-center justify-center">
            <Icon name="progress_activity" size={32} class="text-primary animate-spin" />
          </div>
        {:else if selectedMessage}
          <div class="border-b border-surface-variant bg-surface-container px-4 sm:px-6 py-4 shrink-0">
            <div class="flex items-start justify-between gap-3 mb-3">
              <div class="flex items-center gap-1 md:hidden">
                <button class="btn btn-text btn-sm" onclick={() => { selectedId = null; selectedMessage = null; }}>
                  <Icon name="arrow_back" size={18} /> 返回
                </button>
              </div>
              <h2 class="text-lg font-semibold text-surface-on flex-1 break-words">{esc(selectedMessage.subject) || '(无主题)'}</h2>
              <button class="btn btn-danger btn-sm shrink-0" onclick={deleteMessage}>
                <Icon name="delete" size={16} />
              </button>
            </div>
            <div class="flex items-center gap-3">
              <div class="avatar {avatarColor(selectedMessage.from_address)}">{initial(selectedMessage.from_address)}</div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-surface-on truncate">{esc(selectedMessage.from_address)}</div>
                <div class="text-xs text-surface-on-variant">{fmtFull(selectedMessage.received_at)} · {fmtSize(selectedMessage.raw_size)}</div>
              </div>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto scroll-area">
            {#if otp}
              <div class="mx-4 sm:mx-6 mt-4 p-4 bg-primary-container rounded-m3 flex flex-wrap items-center justify-between gap-3 animate-slide-up">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center">
                    <Icon name="pin" class="text-primary-onContainer" size={22} fill />
                  </div>
                  <div>
                    <div class="text-[11px] text-primary-onContainer/70 font-medium uppercase tracking-wide">验证码</div>
                    <div class="text-2xl font-bold tracking-[0.15em] text-primary-onContainer">{otp}</div>
                  </div>
                </div>
                <button class="btn btn-filled" onclick={() => copy(otp, '验证码')}>
                  <Icon name="content_copy" size={16} /> 复制
                </button>
              </div>
            {/if}

            {#if magicLink}
              <div class="mx-4 sm:mx-6 {otp ? 'mt-2' : 'mt-4'} p-4 bg-secondary-container rounded-m3 flex items-center justify-between gap-3 flex-wrap animate-slide-up">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                  <div class="w-10 h-10 rounded-full bg-secondary/15 flex items-center justify-center shrink-0">
                    <Icon name="link" class="text-secondary-onContainer" size={22} fill />
                  </div>
                  <div class="min-w-0">
                    <div class="text-[11px] text-secondary-onContainer/70 font-medium uppercase tracking-wide">Magic Link · 登录链接</div>
                    <div class="text-sm font-medium text-secondary-onContainer truncate" title={magicLink}>{magicLink}</div>
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <button class="btn btn-tonal" onclick={() => copy(magicLink, 'Magic Link')}>
                    <Icon name="content_copy" size={16} /> 复制
                  </button>
                  <a class="btn btn-filled" href={magicLink} target="_blank" rel="noopener noreferrer">
                    <Icon name="open_in_new" size={16} /> 打开
                  </a>
                </div>
              </div>
            {/if}

            <div class="px-4 sm:px-6 py-4">
              <div class="max-w-3xl">
                <div class="flex items-center gap-2 mb-2 flex-wrap">
                  <button class="btn btn-outlined btn-sm" onclick={() => copy(selectedMessage!.body_text || '', '正文')}>
                    <Icon name="content_copy" size={14} /> 复制正文
                  </button>
                  {#if canToggle}
                    <div class="flex rounded-m3sm overflow-hidden border border-outline ml-auto shrink-0">
                      <button class="px-3 h-8 text-xs font-medium transition-colors {viewMode === 'text' ? 'bg-primary text-primary-on' : 'text-surface-on-variant hover:bg-surface-container-high'}" onclick={() => (viewMode = 'text')}>纯文本</button>
                      <button class="px-3 h-8 text-xs font-medium transition-colors {viewMode === 'html' ? 'bg-primary text-primary-on' : 'text-surface-on-variant hover:bg-surface-container-high'}" onclick={() => (viewMode = 'html')}>HTML</button>
                    </div>
                  {/if}
                </div>
                {#if viewMode === 'html' && selectedMessage.body_html}
                  <iframe class="w-full h-[26rem] md:h-[32rem] rounded-m3 bg-white border-0 block" sandbox="" srcdoc={selectedMessage.body_html} title="邮件 HTML 内容"></iframe>
                {:else}
                  <pre class="bg-surface-container-low p-4 rounded-m3 text-sm whitespace-pre-wrap break-words font-sans leading-relaxed text-surface-on">{esc(selectedMessage.body_text || selectedMessage.body_html) || '(空正文)'}</pre>
                {/if}

                {#if selectedMessage.attachments && selectedMessage.attachments.length > 0}
                  <div class="mt-4">
                    <div class="text-xs text-surface-on-variant mb-2 flex items-center gap-1.5">
                      <Icon name="attach_file" size={14} /> 附件 ({selectedMessage.attachments.length})
                    </div>
                    <div class="space-y-1">
                      {#each selectedMessage.attachments as a (a.id)}
                        <button
                          class="w-full flex items-center gap-3 p-3 rounded-m3sm bg-surface-container-low hover:bg-surface-container-high transition-all text-left"
                          onclick={() => u.jwt && api.downloadAttachment(u.jwt, a.id, a.filename || 'attachment')}
                        >
                          <Icon name="attachment" class="text-primary" size={20} />
                          <div class="min-w-0 flex-1">
                            <div class="text-sm font-medium truncate">{esc(a.filename) || '附件'}</div>
                            <div class="text-xs text-outline">{fmtSize(a.size)}</div>
                          </div>
                          <Icon name="download" class="text-outline" size={18} />
                        </button>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </main>
    </div>
  {/if}
</div>

<!-- 创建邮箱对话框 -->
{#if showCreate}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 animate-fade-in" onclick={() => (showCreate = false)}>
    <div class="card-elevated w-full max-w-md p-6 animate-slide-up" onclick={(e) => e.stopPropagation()}>
      <h3 class="text-lg font-semibold text-surface-on mb-1">创建临时邮箱</h3>
      <p class="text-sm text-surface-on-variant mb-4">留空则随机生成地址</p>
      <form onsubmit={(e) => { e.preventDefault(); void createMailbox(); }}>
        <input
          class="input mb-4"
          placeholder="自定义名称（可选）"
          bind:value={newName}
          autocomplete="off"
          spellcheck="false"
        >
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-text" onclick={() => (showCreate = false)}>取消</button>
          <button type="submit" class="btn btn-filled" disabled={creating}>
            {#if creating}
              <Icon name="progress_activity" size={16} class="animate-spin" /> 创建中…
            {:else}
              <Icon name="add" size={16} /> 创建
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<Toasts />
