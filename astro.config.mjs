// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  trailingSlash: 'never',
  site: process.env.SITE_URL || 'https://jks.ooo',
  integrations: [sitemap({
    filter: (page) => !['/admin', '/404', '/house'].includes(new URL(page).pathname.replace(/\/$/, '')),
  })],
});
