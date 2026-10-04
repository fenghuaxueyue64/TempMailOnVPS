<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$lib/api';
  import { loadUser, saveUser, toast } from '$lib/stores';
  import Icon from '$lib/components/Icon.svelte';
  import Toasts from '$lib/components/Toasts.svelte';

  let code = $state('');
  let loading = $state(false);

  onMount(() => {
    // 已登录直接跳主页
    if (loadUser()) goto('/');
  });

  async function submit(e: Event) {
    e.preventDefault();
    const c = code.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(c)) {
      toast('邀请码格式错误（应为 32 位十六进制）', 'error');
      return;
    }
    loading = true;
    try {
      const r = await api.exchange(c);
      saveUser({ jwt: r.token, userIdMasked: r.user_id_masked });
      toast('登录成功', 'success');
      goto('/');
    } catch (e) {
      toast(`登录失败：${e instanceof ApiError ? e.message : ''}`, 'error');
    } finally {
      loading = false;
    }
  }

  async function paste() {
    try {
      const t = await navigator.clipboard.readText();
      code = t.trim().toLowerCase().replace(/\s/g, '');
    } catch {
      toast('剪贴板读取失败，请手动粘贴', 'error');
    }
  }
</script>

<div class="min-h-screen supports-[height:100dvh]:min-h-dvh flex items-center justify-center p-6 bg-surface">
  <div class="w-full max-w-md animate-fade-in">
    <div class="text-center mb-8">
      <div class="w-20 h-20 rounded-m3lg bg-primary-container mx-auto flex items-center justify-center mb-4 shadow-m1">
        <Icon name="mail" class="text-primary-onContainer" size={48} fill />
      </div>
      <h1 class="text-2xl font-semibold text-surface-on">TempMail 登录</h1>
      <p class="text-sm text-surface-on-variant mt-1">输入邀请码继续</p>
    </div>

    <form class="card-elevated p-6 space-y-4" onsubmit={submit}>
      <div class="relative">
        <span class="absolute left-4 top-1/2 -translate-y-1/2 text-outline">
          <Icon name="key" size={20} />
        </span>
        <input
          type="text"
          class="input pl-12 pr-24 font-mono text-base"
          placeholder="32 位邀请码"
          bind:value={code}
          autocomplete="off"
          spellcheck="false"
        >
        <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 btn btn-text btn-sm" onclick={paste} tabindex="-1">
          <Icon name="content_paste" size={16} /> 粘贴
        </button>
      </div>
      <button type="submit" class="btn btn-filled w-full" disabled={loading || !code.trim()}>
        {#if loading}
          <Icon name="progress_activity" size={18} class="animate-spin" /> 兑换中…
        {:else}
          <Icon name="login" size={18} /> 登录
        {/if}
      </button>
    </form>

    <p class="text-xs text-outline text-center mt-6 leading-relaxed">
      没有邀请码？联系管理员索取。<br>
      邀请码一次性使用，登录后 JWT 在浏览器本地保存 7 天。
    </p>

    <div class="text-center mt-4">
      <a href="/admin" class="btn btn-text btn-sm">
        <Icon name="admin_panel_settings" size={16} /> 管理后台
      </a>
    </div>
  </div>
</div>

<Toasts />
