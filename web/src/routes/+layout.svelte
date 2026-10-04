<script lang="ts">
  import '../app.css';

  let { children } = $props();
</script>

<div class="min-h-screen supports-[height:100dvh]:min-h-dvh">
  {@render children()}
</div>
