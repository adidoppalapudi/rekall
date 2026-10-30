import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Lists every starter deck in index.html as a prefetch link. public/sw.js
 * caches every file index.html lists, so all decks reach the device on the
 * first visit and the starter list opens offline too. The only JSON files in
 * the build are starter decks (see src/io/starterDecks.ts).
 */
function listStarterDecks(): Plugin {
  return {
    name: 'enyalie:list-starter-decks',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (_html, { bundle }) =>
        Object.values(bundle ?? {})
          .filter((file) => file.type === 'asset' && file.fileName.endsWith('.json'))
          .map((file) => ({ tag: 'link', attrs: { rel: 'prefetch', href: `./${file.fileName}` }, injectTo: 'head' })),
    },
  };
}

// https://vite.dev/config/
// base './' makes the build work from any folder (a site root or something
// like https://you.github.io/enyalie/) without changing anything.
// Vitest also reads this file. Tests live in tests/ and run in Node.
export default defineConfig({
  base: './',
  plugins: [react(), listStarterDecks()],
});
