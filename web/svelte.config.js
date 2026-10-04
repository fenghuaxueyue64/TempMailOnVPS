import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      // SPA 模式：所有未匹配路由回退到 index.html，由前端路由处理
      fallback: 'index.html',
      strict: false,
    }),
    alias: {
      $lib: 'src/lib',
    },
  },
};

export default config;
