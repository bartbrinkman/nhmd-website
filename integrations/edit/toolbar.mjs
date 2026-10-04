import { defineToolbarApp } from 'astro/toolbar';
import { createEditor } from './client.mjs';

const STYLE_ID = '__edit-style';

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    [data-editable], [data-editable-anchor] {
      outline: 1px solid transparent;
      outline-offset: 2px;
      cursor: text;
      transition: outline-color 0.12s ease;
    }
    [data-editable]:hover,
    [data-editable-anchor]:hover { outline: 2px solid #001888; }
    [data-edit-active] .ProseMirror,
    [data-edit-active] .ProseMirror:focus {
      outline: none;
      display: inline;
    }
    [data-edit-active] .ProseMirror > p,
    [data-edit-active] .ProseMirror > h1,
    [data-edit-active] .ProseMirror > h2,
    [data-edit-active] .ProseMirror > h3,
    [data-edit-active] .ProseMirror > h4,
    [data-edit-active] .ProseMirror > h5,
    [data-edit-active] .ProseMirror > h6 {
      margin: 0;
      display: inline;
      font: inherit;
      color: inherit;
    }
    [data-edit-active] .ProseMirror > ul,
    [data-edit-active] .ProseMirror > ol { margin: 0; }
    [data-edit-active] .ProseMirror br.ProseMirror-trailingBreak { display: none; }
  `;
  doc.head.append(s);
}

export default defineToolbarApp({
  init(_canvas, app) {
    ensureStyle(document);
    const editor = createEditor(document);

    app.onToggled(({ state }) => {
      if (state) editor.enable();
      else editor.disable();
    });
  },
});
