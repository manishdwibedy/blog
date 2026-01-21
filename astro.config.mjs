import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://blog.manishd.in',
  base: '/',
  outDir: './dist',
  integrations: [
    tailwind(),
    sitemap()
  ]
});

