<script lang="ts">
  // M3 图标组件（Material Symbols Rounded）
  let { name, fill = false, size = 24, class: klass = '' } = $props();
</script>

<span
  class="material-symbols-rounded {fill ? 'fill' : ''} {klass}"
  style="font-size: {size}px; line-height: 1;"
  aria-hidden="true"
>{name}</span>
