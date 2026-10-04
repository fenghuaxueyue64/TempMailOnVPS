<script lang="ts">
  import { toasts } from '$lib/stores';
  import Icon from './Icon.svelte';

  const icon = (type: string) => type === 'error' ? 'error' : type === 'success' ? 'check_circle' : 'info';
  const color = (type: string) => type === 'error' ? 'text-error' : type === 'success' ? 'text-success' : 'text-primary';
</script>

<div class="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
  {#each $toasts as t (t.id)}
    <div class="card-elevated flex items-center gap-3 pr-6 animate-slide-up pointer-events-auto max-w-sm">
      <Icon name={icon(t.type)} class={color(t.type)} size={22} />
      <span class="text-sm">{t.message}</span>
    </div>
  {/each}
</div>
