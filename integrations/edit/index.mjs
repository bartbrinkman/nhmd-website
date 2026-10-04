// Astro integration: adds a dev toolbar app that enables click-to-edit on
// any <p> / <h1>-<h6> in .astro files. Writes back to disk.
//
// - Dev-only: the integration no-ops during `astro build`.
// - Rewrites innerHTML of the target element only — nested tags are lost (by design).
// - Rejects elements whose source inner contains `{…}` (expressions).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { EDITABLE_TAGS, lineColToOffset, rewriteTag, rewriteAnchor, rewriteBlock, readAnchorHref } from './rewrite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function formatWithPrettier(absFile) {
  const raw = await fs.readFile(absFile, 'utf8');
  const options = await prettier.resolveConfig(absFile) || {};
  options.filepath = absFile;
  options.plugins = ['prettier-plugin-astro'];
  const formatted = await prettier.format(raw, options);
  if (formatted !== raw) await fs.writeFile(absFile, formatted, 'utf8');
}

// Common validation + file-read shared by /__edit and /__edit/anchor.
async function prepareEdit(body, root) {
  if (typeof body.file !== 'string' || typeof body.loc !== 'string') {
    return { error: 'bad payload' };
  }
  const absFile = path.resolve(body.file);
  if (!absFile.startsWith(root + path.sep)) return { error: 'path outside project' };
  if (!/\.astro$/.test(absFile)) return { error: 'only .astro files' };
  const [lineStr, colStr] = body.loc.split(':');
  const line = Number(lineStr), col = Number(colStr);
  if (!Number.isFinite(line) || !Number.isFinite(col) || line < 1 || col < 1) {
    return { error: 'bad loc' };
  }
  const src = await fs.readFile(absFile, 'utf8');
  const offset = lineColToOffset(src, line, col);
  if (offset < 0) return { error: 'loc out of range' };
  return { absFile, offset, src };
}

function middleware(root) {
  return async function (req, res, next) {
    // GET /__edit/href?file=…&loc=…  → { raw }
    if (req.method === 'GET' && req.url.startsWith('/__edit/href')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const file = u.searchParams.get('file') || '';
        const loc = u.searchParams.get('loc') || '';
        const prep = await prepareEdit({ file, loc }, root);
        if (prep.error) return fail(res, 400, prep.error);
        const r = readAnchorHref(prep.src, prep.offset);
        if (!r.ok) return fail(res, 400, r.error);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ raw: r.raw }));
      } catch (err) {
        fail(res, 500, err.message);
      }
      return;
    }

    if (req.method !== 'POST') return next();

    // Block rewrite: Tiptap-driven edit of an entire element (opening +
    // inner + closing tag). Newly-introduced blocks (e.g. another <li>) are
    // written verbatim from what Tiptap produces.
    if (req.url.startsWith('/__edit/block')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const prep = await prepareEdit(data, root);
          if (prep.error) return fail(res, 400, prep.error);
          if (typeof data.tag !== 'string' || typeof data.newOuter !== 'string') {
            return fail(res, 400, 'bad payload');
          }
          if (data.newOuter.length > 50_000) return fail(res, 400, 'too long');
          const result = rewriteBlock(prep.src, prep.offset, data.tag, data.newOuter);
          if (!result.ok) return fail(res, 400, result.error);
          await fs.writeFile(prep.absFile, result.out, 'utf8');
          await formatWithPrettier(prep.absFile);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          fail(res, 500, err.message);
        }
      });
      return;
    }

    const isTag = req.url.startsWith('/__edit/anchor')
      ? false
      : req.url.startsWith('/__edit')
        ? true
        : null;
    if (isTag === null) return next();
    const isAnchor = req.url.startsWith('/__edit/anchor');

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const prep = await prepareEdit(data, root);
        if (prep.error) return fail(res, 400, prep.error);

        let result;
        if (isAnchor) {
          if (typeof data.newText !== 'string' || typeof data.newHref !== 'string') {
            return fail(res, 400, 'bad payload');
          }
          if (data.newText.length > 10_000 || data.newHref.length > 2000) {
            return fail(res, 400, 'too long');
          }
          result = rewriteAnchor(prep.src, prep.offset, data.newText, data.newHref);
        } else {
          if (typeof data.tag !== 'string' || typeof data.newHtml !== 'string') {
            return fail(res, 400, 'bad payload');
          }
          if (!EDITABLE_TAGS.includes(data.tag)) return fail(res, 400, 'tag not editable');
          if (data.newHtml.length > 10_000) return fail(res, 400, 'too long');
          result = rewriteTag(prep.src, prep.offset, data.tag, data.newHtml);
        }

        if (!result.ok) return fail(res, 400, result.error);
        await fs.writeFile(prep.absFile, result.out, 'utf8');
        await formatWithPrettier(prep.absFile);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        fail(res, 500, err.message);
      }
    });
  };
}

function fail(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

export default function edit() {
  return {
    name: 'Edit',
    hooks: {
      'astro:config:setup': ({ command, config, updateConfig, addDevToolbarApp, injectScript }) => {
        if (command !== 'dev') return;

        const root = path.resolve(
          config.root instanceof URL ? fileURLToPath(config.root) : (config.root || process.cwd())
        );

        // Astro's built-in Audit toolbar app reads data-astro-source-file/loc
        // into a WeakMap and REMOVES the attributes from the DOM. That runs
        // before our toolbar app activates, so by the time the user toggles
        // edit mode, the elements no longer carry source info.
        //
        // Work around: a head-inline script that snapshots source attrs into
        // data-edit-src-* on DOMContentLoaded, before the toolbar runtime boots.
        injectScript('head-inline', `
          (() => {
            function snap() {
              for (const el of document.querySelectorAll('[data-astro-source-file]')) {
                const f = el.getAttribute('data-astro-source-file');
                const l = el.getAttribute('data-astro-source-loc');
                if (f) el.setAttribute('data-edit-src-file', f);
                if (l) el.setAttribute('data-edit-src-loc', l);
              }
            }
            if (document.readyState === 'loading') {
              document.addEventListener('DOMContentLoaded', snap, { once: true });
            } else {
              snap();
            }

            // Rotate the Astro dev toolbar to a vertical pill pinned to the
            // left-middle. Astro's native \`placement\` only offers bottom-*,
            // so we override its shadow-DOM CSS.
            const TOOLBAR_CSS = \`
              #dev-toolbar-root {
                bottom: auto !important;
                top: 50% !important;
                left: 16px !important;
                right: auto !important;
                transform: translateY(-50%) !important;
                transition: left 0.35s cubic-bezier(0.485, -0.050, 0.285, 1.505) !important;
              }
              #dev-toolbar-root[data-hidden] { left: 16px !important; bottom: auto !important; }
              #dev-toolbar-root[data-hidden] #dev-bar .item { opacity: 1 !important; }
              #dev-bar { height: auto !important; width: 40px !important; }
              #dev-bar #bar-container { flex-direction: column !important; }
              #dev-bar .item { width: 40px !important; height: 44px !important; }
              #dev-bar .separator { width: auto !important; height: 1px !important; }
              #dev-bar .item:first-of-type {
                border-radius: 9999px 9999px 0 0 !important;
                padding: 4px 0 0 0 !important;
                height: 42px !important;
              }
              #dev-bar .item:last-of-type {
                border-radius: 0 0 9999px 9999px !important;
                padding: 0 0 4px 0 !important;
                height: 42px !important;
              }
              #dev-bar-hitbox-above, #dev-bar-hitbox-below {
                width: 16px !important;
                height: auto !important;
                align-self: stretch !important;
              }
              #dev-bar .item-tooltip {
                top: 50% !important;
                left: calc(100% + 10px) !important;
                transform: translateY(-50%) !important;
                white-space: nowrap !important;
              }
              #dev-bar .item-tooltip::after {
                left: -5px !important;
                top: calc(50% - 5px) !important;
                bottom: auto !important;
                border-left: none !important;
                border-top: 5px solid transparent !important;
                border-bottom: 5px solid transparent !important;
                border-right: 5px solid #343841 !important;
              }
            \`;
            function injectToolbarCss() {
              const dt = document.querySelector('astro-dev-toolbar');
              if (!dt || !dt.shadowRoot) return false;
              if (dt.shadowRoot.getElementById('__edit-toolbar-layout')) return true;
              const s = document.createElement('style');
              s.id = '__edit-toolbar-layout';
              s.textContent = TOOLBAR_CSS;
              dt.shadowRoot.append(s);
              return true;
            }
            if (!injectToolbarCss()) {
              const obs = new MutationObserver(() => { if (injectToolbarCss()) obs.disconnect(); });
              obs.observe(document.documentElement, { childList: true, subtree: true });
            }
          })();
        `);

        addDevToolbarApp({
          id: 'edit',
          name: 'Edit',
          icon: '<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/></svg>',
          entrypoint: path.join(here, 'toolbar.mjs'),
        });

        updateConfig({
          vite: {
            plugins: [{
              name: 'edit-server',
              configureServer(server) {
                server.middlewares.use(middleware(root));
              },
            }],
          },
        });
      },
    },
  };
}
