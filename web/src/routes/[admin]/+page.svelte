<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { api, type Domain } from '$lib/api';
  import { adminStore, loadAdmin, saveAdmin, toast } from '$lib/stores';
  import Icon from '$lib/components/Icon.svelte';
  import Toasts from '$lib/components/Toasts.svelte';

  // 管理入口由后端注入到 window.__ADMIN_PATH__（每个部署各不相同）
  // 只有当前路径片段与之完全一致才渲染管理面板，其余一律 404
  const configuredPath: string =
    (typeof window !== 'undefined' && (window as any).__ADMIN_PATH__) || '';
  const slug = $derived($page.params.admin ?? '');
  const allowed = $derived(configuredPath !== '' && slug.toLowerCase() === configuredPath.toLowerCase());

  let jwt = $state<string | null>(null);
  // 登录输入：必须与 jwt 分离，否则一输入就使 jwt truthy 导致登录页消失
  let apiKeyInput = $state('');
  let loginBusy = $state(false);
  let loginError = $state<string | null>(null);
  let cleanupResult = $state<string | null>(null);
  let loadingDomains = $state(false);
  let selectedDomain = $state<string | null>(null);
  let newDomain = $state('');
  let addingDomain = $state(false);

  // DNS 查询状态
  let dnsRecords = $state<any[] | null>(null);
  let dnsLoading = $state(false);
  let dnsError = $state<string | null>(null);

  // 同步/校验状态
  let syncingDomain = $state<string | null>(null);
  let verifyingDomain = $state<string | null>(null);

  const admin = $adminStore;
  const domains = $derived(admin.domains);

  // 域名头像配色
  const domainColors = [
    'bg-primary-container text-primary-onContainer',
    'bg-tertiary-container text-tertiary-onContainer',
    'bg-secondary-container text-secondary-onContainer',
  ];
  function domainColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return domainColors[h % domainColors.length];
  }
  function domainInitial(name: string): string {
    return name[0]?.toUpperCase() || '?';
  }

  const esc = (s?: string) => (s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));

  onMount(() => {
    jwt = loadAdmin();
    if (jwt) void loadDomains();
  });

  async function loadDomains() {
    if (!jwt) return;
    loadingDomains = true;
    try {
      const r = await api.listDomains(jwt);
      adminStore.update((s) => ({ ...s, domains: r.domains }));
    } catch (e) {
      if (e instanceof Error && e.message.includes('会话过期')) logout();
      else toast(`加载失败：${e instanceof Error ? e.message : ''}`, 'error');
    } finally {
      loadingDomains = false;
    }
  }

  // ADMIN_API_KEY → JWT（不能把 key 直接当 token 用）
  async function login() {
    const key = apiKeyInput.trim();
    if (!key) return;
    loginBusy = true;
    loginError = null;
    try {
      const r = await api.adminLogin(key);
      if (!r?.token) throw new Error('服务端未返回 token');
      saveAdmin(r.token);
      jwt = r.token;
      apiKeyInput = '';
      adminStore.update((s) => ({ ...s, jwt: r.token }));
      await loadDomains();
    } catch (e) {
      loginError = e instanceof Error ? e.message : '登录失败';
    } finally {
      loginBusy = false;
    }
  }

  function logout() {
    saveAdmin(null);
    jwt = null;
    apiKeyInput = '';
    loginError = null;
    adminStore.set({ jwt: null, domains: [], invitations: [] });
    selectedDomain = null;
  }

  async function addDomain() {
    const d = newDomain.trim().toLowerCase();
    if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) {
      toast('域名格式无效', 'error');
      return;
    }
    addingDomain = true;
    try {
      const r = await api.addDomain(jwt!, d);
      toast(r.error ? `已添加，deSEC 同步失败：${r.error}` : `已添加 ${d}`, r.error ? 'error' : 'success');
      newDomain = '';
      await loadDomains();
    } catch (e) {
      toast(`添加失败：${e instanceof Error ? e.message : ''}`, 'error');
    } finally {
      addingDomain = false;
    }
  }

  async function selectDomain(name: string) {
    selectedDomain = name;
    dnsRecords = null;
    dnsError = null;
    if (!jwt) return;
    dnsLoading = true;
    try {
      const r = await api.viewDns(jwt, name);
      dnsRecords = r.rrsets || [];
    } catch (e) {
      dnsError = e instanceof Error ? e.message : '查询失败';
    } finally {
      dnsLoading = false;
    }
  }

  async function syncDomain(name: string) {
    if (!confirm(`重新同步 ${name} 的 A/MX/SPF 到 deSEC？`)) return;
    syncingDomain = name;
    try {
      const r = await api.syncDomain(jwt!, name);
      toast(r.mx_synced ? `${name} MX 已同步` : `同步失败：${r.error || ''}`, r.mx_synced ? 'success' : 'error');
      await loadDomains();
      if (selectedDomain === name) await selectDomain(name);
    } catch (e) {
      toast(`同步失败：${e instanceof Error ? e.message : ''}`, 'error');
    } finally {
      syncingDomain = null;
    }
  }

  async function verifyDomain(name: string) {
    verifyingDomain = name;
    try {
      const r = await api.verifyDomain(jwt!, name);
      toast(r.ok ? `${name} MX 已生效：${r.records.join(', ')}` : `${name} MX 未生效`, r.ok ? 'success' : 'error');
    } catch (e) {
      toast(`校验失败：${e instanceof Error ? e.message : ''}`, 'error');
    } finally {
      verifyingDomain = null;
    }
  }

  async function delDomain(name: string) {
    if (!confirm(`停用域名 ${name}？`)) return;
    try {
      await api.deleteDomain(jwt!, name);
      toast(`已停用 ${name}`, 'success');
      if (selectedDomain === name) selectedDomain = null;
      await loadDomains();
    } catch (e) {
      toast(`停用失败：${e instanceof Error ? e.message : ''}`, 'error');
    }
  }

  async function cleanup() {
    if (!jwt) return;
    try {
      const r = await api.cleanup(jwt);
      cleanupResult = `已清理 ${r.removed_mailboxes} 个过期邮箱`;
      toast(`已清理 ${r.removed_mailboxes} 个过期邮箱`, 'success');
      setTimeout(() => (cleanupResult = null), 5000);
    } catch (e) {
      toast(`清理失败：${e instanceof Error ? e.message : ''}`, 'error');
    }
  }

  const typeColor = (t: string) =>
    t === 'MX' ? 'chip-primary' :
    t === 'A' ? 'chip-success' :
    t === 'TXT' ? 'chip-neutral' : 'chip-neutral';

  // 时间格式化（与主页一致，处理 SQLite 空格分隔的 UTC 时间戳）
  function parseDbDate(iso: string): Date {
    const norm = iso.includes('T') ? iso : iso.replace(' ', 'T');
    return new Date(norm.endsWith('Z') ? norm : `${norm}Z`);
  }
  function fmtFull(iso: string): string {
    return parseDbDate(iso).toLocaleString('zh-CN');
  }
  const cfg_max_inv = 50;

  // ===== 邀请码管理 =====
  let tab = $state<'domains' | 'invitations'>('domains');
  let invitations = $state<any[]>([]);
  let loadingInvitations = $state(false);
  let invCount = $state(1);
  let invNote = $state('');
  let invTtl = $state(168);
  let creatingInv = $state(false);
  let invStatusFilter = $state<'all' | 'unused' | 'used' | 'expired'>('all');
  let createdCodes = $state<string[]>([]);   // 刚生成的一批，单独高亮便于复制

  async function loadInvitations() {
    if (!jwt) return;
    loadingInvitations = true;
    try {
      const r = await api.listInvitations(jwt, invStatusFilter);
      invitations = r.invitations;
    } catch (e) {
      toast(`加载邀请码失败：${e instanceof Error ? e.message : ''}`, 'error');
    } finally {
      loadingInvitations = false;
    }
  }

  async function createInvitations() {
    if (!jwt) return;
    creatingInv = true;
    try {
      const r = await api.createInvitations(jwt, { count: invCount, note: invNote, ttl_hours: invTtl });
      createdCodes = r.codes;
      toast(`已生成 ${r.count} 个邀请码`, 'success');
      await loadInvitations();
    } catch (e) {
      toast(`生成失败：${e instanceof Error ? e.message : ''}`, 'error');
    } finally {
      creatingInv = false;
    }
  }

  async function deleteInvitation(code: string) {
    if (!jwt || !confirm(`撤销邀请码 ${code.slice(0, 8)}…？`)) return;
    try {
      await api.deleteInvitation(jwt, code);
      invitations = invitations.filter((i) => i.code !== code);
      toast('已撤销', 'success');
    } catch (e) {
      toast(`撤销失败：${e instanceof Error ? e.message : ''}`, 'error');
    }
  }

  async function copyAllCodes() {
    if (createdCodes.length === 0) return;
    await navigator.clipboard.writeText(createdCodes.join('\n'));
    toast(`已复制 ${createdCodes.length} 个邀请码`, 'success');
  }

  function invStatus(inv: any): 'unused' | 'used' | 'expired' {
    if (inv.used_at) return 'used';
    if (new Date(inv.expires_at.endsWith('Z') ? inv.expires_at : inv.expires_at + 'Z').getTime() <= Date.now()) return 'expired';
    return 'unused';
  }
</script>

{#if !allowed}
  <!-- 路径不匹配配置的管理入口：当作不存在 -->
  <div class="min-h-screen supports-[height:100dvh]:min-h-dvh flex items-center justify-center p-6 bg-surface">
    <div class="text-center">
      <Icon name="search_off" size={64} class="text-outline mx-auto mb-4 opacity-40" />
      <p class="text-base text-surface-on-variant">页面不存在</p>
      <a href="/" class="btn btn-text btn-sm mt-4">
        <Icon name="home" size={16} /> 返回首页
      </a>
    </div>
  </div>
{:else}
<div class="h-screen supports-[height:100dvh]:h-dvh flex flex-col bg-surface pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
  <!-- 顶部应用栏 -->
  <header class="h-16 px-4 sm:px-6 flex items-center justify-between border-b border-surface-variant bg-surface-container shrink-0">
    <div class="flex items-center gap-3 min-w-0">
      <div class="w-9 h-9 rounded-m3sm bg-primary flex items-center justify-center shadow-m1 shrink-0">
        <Icon name="admin_panel_settings" class="text-primary-on" size={22} fill />
      </div>
      <div class="min-w-0">
        <h1 class="text-base font-semibold text-surface-on leading-tight">管理后台</h1>
        <p class="text-[11px] text-surface-on-variant leading-tight">域名与 DNS 管理</p>
      </div>
    </div>
    <div class="flex items-center gap-1">
      <a href="/" class="btn btn-text btn-sm" title="用户端">
        <Icon name="arrow_back" size={18} />
        <span class="hidden sm:inline">用户端</span>
      </a>
      <button class="btn btn-text btn-sm" onclick={logout} title="退出">
        <Icon name="logout" size={18} />
        <span class="hidden sm:inline">退出</span>
      </button>
    </div>
  </header>

  {#if !jwt}
    <!-- 登录页 -->
    <div class="flex-1 flex items-center justify-center p-6">
      <div class="w-full max-w-md animate-fade-in">
        <div class="text-center mb-8">
          <div class="w-20 h-20 rounded-m3lg bg-primary-container mx-auto flex items-center justify-center mb-4 shadow-m1">
            <Icon name="lock" class="text-primary-onContainer" size={48} fill />
          </div>
          <h2 class="text-xl font-semibold text-surface-on">管理后台登录</h2>
          <p class="text-sm text-surface-on-variant mt-1">输入 ADMIN_API_KEY 继续</p>
        </div>
        <form class="card-elevated p-6 space-y-4" onsubmit={(e) => { e.preventDefault(); void login(); }}>
          <div class="relative">
            <span class="absolute left-4 top-1/2 -translate-y-1/2 text-outline">
              <Icon name="key" size={20} />
            </span>
            <input
              type="password"
              class="input pl-12"
              placeholder="ADMIN_API_KEY"
              bind:value={apiKeyInput}
              disabled={loginBusy}
              autocomplete="off"
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void login(); } }}
            >
          </div>
          {#if loginError}
            <p class="text-sm text-error flex items-center gap-1.5">
              <Icon name="error" size={16} /> {esc(loginError)}
            </p>
          {/if}
          <button type="submit" class="btn btn-filled w-full" disabled={loginBusy || !apiKeyInput.trim()}>
            {#if loginBusy}
              <Icon name="progress_activity" size={18} class="animate-spin" /> 登录中…
            {:else}
              <Icon name="login" size={18} /> 登录
            {/if}
          </button>
        </form>
      </div>
    </div>
  {:else}
    <!-- Tab 切换 -->
    <div class="px-4 sm:px-6 pt-3 flex items-center gap-1 border-b border-surface-variant bg-surface-container shrink-0">
      <button class="px-4 h-10 text-sm font-medium border-b-2 transition-colors {tab === 'domains' ? 'border-primary text-primary' : 'border-transparent text-surface-on-variant hover:text-surface-on'}" onclick={() => (tab = 'domains')}>
        <Icon name="dns" size={16} class="align-middle mr-1" /> 域名
      </button>
      <button class="px-4 h-10 text-sm font-medium border-b-2 transition-colors {tab === 'invitations' ? 'border-primary text-primary' : 'border-transparent text-surface-on-variant hover:text-surface-on'}" onclick={() => { tab = 'invitations'; void loadInvitations(); }}>
        <Icon name="vpn_key" size={16} class="align-middle mr-1" /> 邀请码
      </button>
    </div>

    {#if tab === 'invitations'}
      <!-- 邀请码管理 -->
      <div class="flex-1 overflow-y-auto scroll-area">
        <div class="max-w-5xl mx-auto px-4 sm:px-6 py-6">
          <!-- 生成新区 -->
          <div class="card p-5 mb-6">
            <h3 class="text-base font-semibold text-surface-on mb-3 flex items-center gap-2">
              <Icon name="add_circle" class="text-primary" size={20} /> 生成邀请码
            </h3>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              <div>
                <label class="text-xs text-surface-on-variant block mb-1">数量（1-{cfg_max_inv})</label>
                <input type="number" min="1" max="50" class="input h-10" bind:value={invCount}>
              </div>
              <div>
                <label class="text-xs text-surface-on-variant block mb-1">有效期（小时）</label>
                <input type="number" min="1" max="720" class="input h-10" bind:value={invTtl}>
              </div>
              <div>
                <label class="text-xs text-surface-on-variant block mb-1">备注（可选）</label>
                <input type="text" maxlength="200" class="input h-10" placeholder="如：给张三" bind:value={invNote}>
              </div>
            </div>
            <button class="btn btn-filled" onclick={createInvitations} disabled={creatingInv}>
              {#if creatingInv}
                <Icon name="progress_activity" size={16} class="animate-spin" /> 生成中…
              {:else}
                <Icon name="add" size={16} /> 生成
              {/if}
            </button>

            {#if createdCodes.length > 0}
              <div class="mt-5 p-4 bg-success-container/50 rounded-m3 animate-slide-up">
                <div class="flex items-center justify-between mb-2">
                  <div class="text-sm font-semibold text-success flex items-center gap-1.5">
                    <Icon name="check_circle" size={16} /> 已生成 {createdCodes.length} 个邀请码
                  </div>
                  <button class="btn btn-tonal btn-sm" onclick={copyAllCodes}>
                    <Icon name="content_copy" size={14} /> 全部复制
                  </button>
                </div>
                <div class="space-y-1 max-h-48 overflow-y-auto scroll-area">
                  {#each createdCodes as c}
                    <div class="flex items-center gap-2 bg-surface-container p-2 rounded-m3sm">
                      <code class="text-xs flex-1 font-mono text-surface-on break-all">{c}</code>
                      <button class="btn btn-text btn-sm shrink-0" onclick={() => navigator.clipboard.writeText(c).then(() => toast('已复制', 'success'))}>
                        <Icon name="content_copy" size={14} />
                      </button>
                    </div>
                  {/each}
                </div>
                <p class="text-[11px] text-surface-on-variant mt-2">将邀请码发给用户，他们在 /login 页输入即可登录。</p>
              </div>
            {/if}
          </div>

          <!-- 列表区 -->
          <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 class="text-base font-semibold text-surface-on flex items-center gap-2">
              <Icon name="list" class="text-primary" size={20} /> 邀请码列表
            </h3>
            <div class="flex items-center gap-1">
              {#each [['all', '全部'], ['unused', '未用'], ['used', '已用'], ['expired', '已过期']] as [val, label]}
                <button class="btn btn-sm {invStatusFilter === val ? 'btn-tonal' : 'btn-text'}" onclick={() => { invStatusFilter = val as any; void loadInvitations(); }}>{label}</button>
              {/each}
              <button class="btn btn-text btn-sm" onclick={loadInvitations} disabled={loadingInvitations} title="刷新">
                <Icon name="refresh" size={14} class={loadingInvitations ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {#if loadingInvitations && invitations.length === 0}
            {#each Array(4) as _}
              <div class="card p-4 mb-2">
                <div class="skeleton h-4 w-2/3 mb-2"></div>
                <div class="skeleton h-3 w-1/3"></div>
              </div>
            {/each}
          {:else if invitations.length === 0}
            <div class="text-center py-12">
              <Icon name="vpn_key" size={48} class="text-outline mx-auto mb-3 opacity-50" />
              <p class="text-sm text-surface-on-variant">暂无邀请码</p>
            </div>
          {:else}
            <div class="space-y-2">
              {#each invitations as inv (inv.code)}
                {@const st = invStatus(inv)}
                <div class="card p-4 flex items-center gap-3 flex-wrap">
                  <div class="flex-1 min-w-0">
                    <code class="text-xs font-mono text-surface-on break-all">{inv.code}</code>
                    {#if inv.note}
                      <div class="text-xs text-surface-on-variant mt-1">备注：{esc(inv.note)}</div>
                    {/if}
                    <div class="text-xs text-outline mt-1">
                      创建：{fmtFull(inv.created_at)} · 过期：{fmtFull(inv.expires_at)}
                      {#if inv.used_at} · 使用：{fmtFull(inv.used_at)}{/if}
                    </div>
                  </div>
                  <span class="chip {st === 'unused' ? 'chip-success' : st === 'used' ? 'chip-primary' : 'chip-error'} text-[10px] h-5 shrink-0">
                    {st === 'unused' ? '未使用' : st === 'used' ? '已使用' : '已过期'}
                  </span>
                  {#if st === 'unused'}
                    <button class="btn btn-text btn-sm shrink-0" onclick={() => navigator.clipboard.writeText(inv.code).then(() => toast('已复制', 'success'))} title="复制">
                      <Icon name="content_copy" size={14} />
                    </button>
                    <button class="btn btn-danger btn-sm shrink-0" onclick={() => deleteInvitation(inv.code)} title="撤销">
                      <Icon name="block" size={14} />
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {:else}
    <!-- 主体双栏（域名管理） -->
    <div class="flex-1 flex overflow-hidden">
      <!-- 左：域名列表 -->
      <aside class="w-full md:w-[380px] lg:w-[420px] border-r border-surface-variant bg-surface-container-low flex flex-col shrink-0 {selectedDomain ? 'hidden md:flex' : ''}">
        <div class="px-4 py-3 flex items-center justify-between shrink-0">
          <h2 class="text-sm font-semibold text-surface-on flex items-center gap-2">
            <Icon name="dns" class="text-primary" size={18} />
            域名
            <span class="text-xs font-normal text-surface-on-variant">({domains.length})</span>
          </h2>
          <button class="btn btn-text btn-sm" onclick={loadDomains} title="刷新" disabled={loadingDomains}>
            <Icon name="refresh" size={16} class={loadingDomains ? 'animate-spin' : ''} />
          </button>
        </div>

        <!-- 添加域名 -->
        <div class="px-3 pb-2 shrink-0">
          <form class="flex gap-1.5" onsubmit={(e) => { e.preventDefault(); void addDomain(); }}>
            <input
              class="input h-10 flex-1 text-base"
              placeholder="example.com"
              bind:value={newDomain}
              disabled={addingDomain}
            >
            <button type="submit" class="btn btn-filled btn-sm" disabled={addingDomain || !newDomain.trim()}>
              {#if addingDomain}
                <Icon name="progress_activity" size={16} class="animate-spin" />
              {:else}
                <Icon name="add" size={16} />
              {/if}
            </button>
          </form>
        </div>

        <div class="flex-1 overflow-y-auto scroll-area px-2 pb-2">
          {#if loadingDomains && domains.length === 0}
            {#each Array(4) as _}
              <div class="flex items-center gap-3 p-3">
                <div class="skeleton w-10 h-10 rounded-full"></div>
                <div class="flex-1 space-y-2">
                  <div class="skeleton h-3 w-2/3"></div>
                  <div class="skeleton h-3 w-1/3"></div>
                </div>
              </div>
            {/each}
          {:else if domains.length === 0}
            <div class="text-center py-16 px-4">
              <Icon name="dns" size={48} class="text-outline mx-auto mb-3 opacity-50" />
              <p class="text-sm text-surface-on-variant">暂无域名</p>
              <p class="text-xs text-outline mt-1">在上方添加一个域名</p>
            </div>
          {:else}
            {#each domains as d (d.id)}
              <button
                class="mail-item w-full text-left {selectedDomain === d.domain ? 'active' : ''}"
                onclick={() => selectDomain(d.domain)}
              >
                <div class="avatar {domainColor(d.domain)}">{domainInitial(d.domain)}</div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium text-surface-on truncate">{esc(d.domain)}</div>
                  <div class="flex gap-1 mt-1">
                    <span class="chip {d.is_active ? 'chip-success' : 'chip-neutral'} text-[10px] h-5">
                      {d.is_active ? '活跃' : '停用'}
                    </span>
                    <span class="chip {d.mx_synced ? 'chip-primary' : 'chip-error'} text-[10px] h-5">
                      MX {d.mx_synced ? '已配' : '未配'}
                    </span>
                  </div>
                </div>
              </button>
            {/each}
          {/if}
        </div>

        <!-- 维护区 -->
        <div class="border-t border-surface-variant p-3 shrink-0 bg-surface-container">
          <button class="btn btn-tonal w-full" onclick={cleanup}>
            <Icon name="cleaning_services" size={18} /> 清理过期邮箱
          </button>
          {#if cleanupResult}
            <p class="text-xs text-success mt-2 text-center flex items-center justify-center gap-1">
              <Icon name="check_circle" size={14} /> {cleanupResult}
            </p>
          {/if}
        </div>
      </aside>

      <!-- 右：详情面板 -->
      <main class="flex-1 overflow-hidden {selectedDomain ? 'flex flex-col' : 'hidden md:block'}">
        {#if !selectedDomain}
          <div class="h-full flex items-center justify-center p-6">
            <div class="text-center">
              <Icon name="dns" size={64} class="text-outline mx-auto mb-4 opacity-40" />
              <p class="text-sm text-surface-on-variant">从左侧选择一个域名查看 DNS 记录</p>
            </div>
          </div>
        {:else}
          <!-- 详情头 -->
          <div class="border-b border-surface-variant bg-surface-container px-4 sm:px-6 py-4 shrink-0">
            <div class="flex items-start justify-between gap-3 mb-3">
              <div class="flex items-center gap-1 md:hidden">
                <button class="btn btn-text btn-sm" onclick={() => (selectedDomain = null)}>
                  <Icon name="arrow_back" size={18} /> 返回
                </button>
              </div>
              <div class="flex items-center gap-3 flex-1 min-w-0">
                <div class="avatar {domainColor(selectedDomain)} text-lg">{domainInitial(selectedDomain)}</div>
                <div class="min-w-0">
                  <h2 class="text-lg font-semibold text-surface-on truncate">{esc(selectedDomain)}</h2>
                  <p class="text-xs text-surface-on-variant">DNS 记录与管理</p>
                </div>
              </div>
            </div>
            <div class="flex gap-1.5 flex-wrap">
              <button class="btn btn-tonal btn-sm" onclick={() => syncDomain(selectedDomain!)} disabled={syncingDomain === selectedDomain}>
                {#if syncingDomain === selectedDomain}
                  <Icon name="progress_activity" size={14} class="animate-spin" />
                {:else}
                  <Icon name="sync" size={14} />
                {/if}
                同步 MX
              </button>
              <button class="btn btn-outlined btn-sm" onclick={() => verifyDomain(selectedDomain!)} disabled={verifyingDomain === selectedDomain}>
                {#if verifyingDomain === selectedDomain}
                  <Icon name="progress_activity" size={14} class="animate-spin" />
                {:else}
                  <Icon name="check_circle" size={14} />
                {/if}
                校验 MX
              </button>
              <button class="btn btn-danger btn-sm" onclick={() => delDomain(selectedDomain!)}>
                <Icon name="block" size={14} /> 停用
              </button>
            </div>
          </div>

          <!-- DNS 记录 -->
          <div class="flex-1 overflow-y-auto scroll-area px-4 sm:px-6 py-4">
            <h3 class="text-sm font-semibold text-surface-on mb-3 flex items-center gap-2">
              <Icon name="list_alt" class="text-primary" size={18} /> DNS 记录
            </h3>

            {#if dnsLoading}
              {#each Array(3) as _}
                <div class="card p-4 mb-2">
                  <div class="skeleton h-4 w-1/4 mb-2"></div>
                  <div class="skeleton h-3 w-full"></div>
                </div>
              {/each}
            {:else if dnsError}
              <div class="card p-4 bg-error-container/50">
                <div class="flex items-center gap-2 text-error-onContainer">
                  <Icon name="error" class="text-error" size={20} />
                  <span class="text-sm">{esc(dnsError)}</span>
                </div>
              </div>
            {:else if !dnsRecords || dnsRecords.length === 0}
              <div class="text-center py-8">
                <Icon name="inbox" size={40} class="text-outline mx-auto mb-2 opacity-50" />
                <p class="text-sm text-surface-on-variant">无 DNS 记录</p>
              </div>
            {:else}
              {#each dnsRecords as r (r.type + r.subname)}
                <div class="card p-4 mb-2 animate-fade-in">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="chip {typeColor(r.type)}">{r.type}</span>
                    <span class="text-sm font-medium text-surface-on">{r.subname || '@'}</span>
                    <span class="text-xs text-outline ml-auto">TTL {r.ttl}</span>
                  </div>
                  <div class="text-sm text-surface-on-variant font-mono break-all">
                    {#each r.records as rec}
                      <div class="py-0.5">{esc(rec)}</div>
                    {/each}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </main>
    </div>
    {/if}
  {/if}

  <Toasts />
</div>
{/if}
