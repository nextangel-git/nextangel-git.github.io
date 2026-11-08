// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  trailingSlash: 'never',
  site: 'https://jks-sosnovoborsk.surge.sh',
  integrations: [sitemap()],
});
