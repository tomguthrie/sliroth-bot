import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

/** Builds the Worker with source maps; the Cloudflare plugin loads SQL imports as text. */
export default defineConfig({
  plugins: [cloudflare()],
  environments: {
    ssr: { build: { sourcemap: true } },
  },
});
