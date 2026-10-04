// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import edit from './integrations/edit/index.mjs';

// Deploy target is env-driven: the GitHub Pages build uses the defaults below;
// a build for nhmd.nl itself sets SITE_URL=https://www.nhmd.nl and BASE_PATH=/.
const site = process.env.SITE_URL ?? 'https://bartbrinkman.github.io';
const base = process.env.BASE_PATH ?? '/nhmd-website';

export default defineConfig({
  site,
  base,
  integrations: [edit()],
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      include: ['@tiptap/core', '@tiptap/starter-kit', '@tiptap/extension-link', '@tiptap/extension-bubble-menu'],
    },
    resolve: {
      dedupe: [
        '@tiptap/core',
        'prosemirror-state',
        'prosemirror-view',
        'prosemirror-model',
        'prosemirror-transform',
        'prosemirror-commands',
        'prosemirror-keymap',
      ],
    },
  }
});
