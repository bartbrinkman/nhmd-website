import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Document from '@tiptap/extension-document';
import Heading from '@tiptap/extension-heading';
import Link from '@tiptap/extension-link';
import BubbleMenu from '@tiptap/extension-bubble-menu';
import { cleanTiptapHtml, reshapeOuterForSave } from './rewrite.mjs';

// Constrain the document to exactly one top-level block. The source element
// we're editing is a single block (one <p>, one <h2>, one <ul>, …) and we
// write back a single block. Allowing `block+` (StarterKit's default) means
// Enter on a heading splits into `<h3>x</h3><h3></h3>`, the trailing empty
// block lands in the saved source, and list Enter behaves erratically.
const SingleBlockDocument = Document.extend({ content: 'block' });

// WYSIWYG: turn off the `# ` / `## ` markdown-style heading input rules.
// Users pick heading levels from the bubble-menu select; auto-conversion
// while typing surprises them.
const HeadingNoMarkdown = Heading.extend({
  addInputRules() { return []; },
  addPasteRules() { return []; },
});

export const EDITABLE_TEXT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'span', 'div', 'ul', 'ol'];
export const EDITABLE = EDITABLE_TEXT_TAGS;
const TEXT_ATTR = 'data-editable';
const ANCHOR_ATTR = 'data-editable-anchor';
const ACTIVE_ATTR = 'data-edit-active';

export function createEditor(doc, opts = {}) {
  const fetchImpl = opts.fetchImpl || (globalThis.fetch && globalThis.fetch.bind(globalThis));
  const win = opts.win || doc.defaultView || globalThis;

  let active = false;
  let mo = null;
  let clickHandler = null;
  let currentPopover = null;
  let currentTiptap = null; // { editor, host, originalOuter, tag }

  function hasSourceInfo(el) {
    return (el.getAttribute('data-edit-src-file') || el.getAttribute('data-astro-source-file'))
      && (el.getAttribute('data-edit-src-loc') || el.getAttribute('data-astro-source-loc'));
  }

  function sourceOf(el) {
    return {
      file: el.getAttribute('data-edit-src-file') || el.getAttribute('data-astro-source-file'),
      loc: el.getAttribute('data-edit-src-loc') || el.getAttribute('data-astro-source-loc'),
    };
  }

  // An element is a "text leaf" when the only children are text nodes, <br>,
  // or anchors nested inside the paragraph/list-item. We explicitly allow
  // anchors so Tiptap can edit <p>foo <a>bar</a> baz</p> as a rich text node.
  function isTextLeaf(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) continue; // text
      if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'br' || tag === 'a' || tag === 'strong' || tag === 'em' || tag === 'b' || tag === 'i') continue;
        return false;
      }
    }
    return true;
  }

  // Lists: a <ul>/<ol> is editable if every direct <li> child is itself a leaf.
  function isEditableList(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === 3) continue;
      if (child.nodeType === 1) {
        if (child.tagName.toLowerCase() !== 'li') return false;
        if (!isTextLeaf(child)) return false;
      }
    }
    return true;
  }

  // Elements inside the site header (logo, nav, etc.) are out of scope —
  // that's template scaffolding, not page content. Also skip the Astro dev
  // toolbar itself.
  function inSkippedRegion(el) {
    return !!el.closest('header, astro-dev-toolbar, astro-dev-overlay');
  }

  function markEditable() {
    for (const n of doc.querySelectorAll(EDITABLE_TEXT_TAGS.join(','))) {
      if (!hasSourceInfo(n)) continue;
      if (inSkippedRegion(n)) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        if (!isEditableList(n)) continue;
      } else {
        if (!isTextLeaf(n)) continue;
        if (tag === 'li') continue;
      }
      n.setAttribute(TEXT_ATTR, '');
    }
    for (const a of doc.querySelectorAll('a')) {
      if (!hasSourceInfo(a)) continue;
      if (inSkippedRegion(a)) continue;
      // Anchors inside a text-editable block are owned by Tiptap's bubble
      // menu (🔗 button). Don't expose a separate popover for them.
      if (a.closest('[' + TEXT_ATTR + ']')) continue;
      a.setAttribute(ANCHOR_ATTR, '');
    }
  }

  function unmarkEditable() {
    closeTiptap(); // persist anything in progress
    for (const n of doc.querySelectorAll('[' + TEXT_ATTR + ']')) {
      n.removeAttribute(TEXT_ATTR);
    }
    for (const a of doc.querySelectorAll('[' + ANCHOR_ATTR + ']')) {
      a.removeAttribute(ANCHOR_ATTR);
    }
    closePopover();
  }

  const lastResults = [];

  // --- Tiptap block editor ----------------------------------------------

  // Tiptap StarterKit-minus-stuff-we-don't-allow. The schema IS the whitelist:
  // anything not declared here cannot be produced by the editor.
  function makeTiptapExtensions(bubbleEl) {
    const exts = [
      StarterKit.configure({
        document: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        heading: false,
        strike: false,
      }),
      SingleBlockDocument,
      HeadingNoMarkdown.configure({ levels: [1, 2, 3, 4] }),
      Link.configure({
        openOnClick: false,
        autolink: false,
        HTMLAttributes: { rel: 'noopener', target: null },
      }),
    ];
    if (bubbleEl) {
      exts.push(BubbleMenu.configure({
        element: bubbleEl,
        options: {
          placement: 'top',
          offset: 8,
        },
      }));
    }
    return exts;
  }

  // Build the floating formatting toolbar that appears above the selection.
  function buildBubbleMenu() {
    const bar = doc.createElement('div');
    bar.className = 'edit-bubble-menu';
    bar.style.cssText = `
      display: flex;
      gap: 2px;
      padding: 4px;
      background: #1a1a1a;
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.3);
      font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      z-index: 2147483600;
    `;
    return bar;
  }

  function addBubbleButton(bar, label, title, onClick, isActive) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    btn.dataset.cmd = title;
    btn.style.cssText = `
      padding: 4px 9px;
      background: transparent;
      color: #fff;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
      min-width: 28px;
    `;
    btn.addEventListener('mousedown', (e) => {
      // mousedown, not click — Tiptap's view loses selection on click otherwise
      e.preventDefault();
      onClick();
    });
    btn._isActive = isActive;
    bar.append(btn);
    return btn;
  }

  function closeTiptap({ cancel = false } = {}) {
    if (!currentTiptap) return;
    const { editor, host, originalOuter, tag, file, loc, bubble } = currentTiptap;
    const newContent = cleanTiptapHtml(editor.getHTML());
    editor.destroy();
    if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);

    const newOuter = reshapeOuterForSave(tag, newContent);

    // Replace the Tiptap host with the element that matches the final state:
    //   - on cancel → original outer
    //   - on save   → the new outer (so there's no "flash of original" before HMR reloads)
    const finalHtml = cancel ? originalOuter : newOuter;
    const replacement = templateElement(finalHtml);
    if (replacement.nodeType === 1) {
      replacement.setAttribute('data-edit-src-file', file);
      replacement.setAttribute('data-edit-src-loc', loc);
    }
    host.replaceWith(replacement);
    currentTiptap = null;
    if (active) markEditable();

    if (!cancel && newOuter !== originalOuter) {
      saveBlock({ file, loc, tag, newOuter, originalOuter }).then((r) => lastResults.push(r));
    }
  }

async function saveBlock({ file, loc, tag, newOuter, originalOuter }) {
    if (newOuter === originalOuter) return { ok: true, noop: true };
    try {
      const res = await fetchImpl('/__edit/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, loc, tag, newOuter }),
      });
      if (!res.ok) {
        let err = {};
        try { err = await res.json(); } catch {}
        return { ok: false, error: err.error || res.statusText };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function beginTextEdit(el) {
    if (currentTiptap) closeTiptap();
    const tag = el.tagName.toLowerCase();
    const { file, loc } = sourceOf(el);
    const originalOuter = el.outerHTML;

    const host = doc.createElement(tag);
    host.setAttribute(ACTIVE_ATTR, '');
    if (el.className) host.className = el.className;
    const inlineStyle = el.getAttribute('style');
    if (inlineStyle) host.setAttribute('style', inlineStyle);
    el.replaceWith(host);

    // Build the floating toolbar (rendered by the BubbleMenu extension).
    const bubble = buildBubbleMenu();
    bubble.style.visibility = 'hidden'; // Tiptap shows/hides this for us
    doc.body.append(bubble);

    const seedContent = originalOuter;
    let editor;
    const buttons = [];
    try {
      editor = new Editor({
        element: host,
        extensions: makeTiptapExtensions(bubble),
        content: seedContent,
        autofocus: 'end',
        editorProps: {
          handleKeyDown(_view, ev) {
            if (ev.key === 'Escape') {
              ev.preventDefault();
              closeTiptap({ cancel: true });
              return true;
            }
            return false;
          },
        },
        // We don't close on blur — bubble-menu mousedown and transient focus
        // loss would tear down the editor mid-edit. Instead we close when the
        // user clicks outside host+bubble or starts editing a different
        // element (see onClick and the outside-click handler below).
      });
    } catch (err) {
      host.replaceWith(templateElement(originalOuter));
      bubble.remove();
      // eslint-disable-next-line no-console
      console.error('[edit] Tiptap init failed:', err);
      return;
    }

    // Populate the toolbar now that `editor` exists.
    const blockSelect = doc.createElement('select');
    blockSelect.title = 'Block type';
    blockSelect.style.cssText = `
      padding: 3px 6px;
      background: #2a2a2a;
      color: #fff;
      border: 1px solid #444;
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
      margin-right: 4px;
    `;
    // Lists don't get a block-type switcher — it would fight with list nodes.
    if (tag === 'ul' || tag === 'ol') blockSelect.style.display = 'none';
    for (const [val, label] of [
      ['p', 'Paragraph'],
      ['h1', 'Heading 1'],
      ['h2', 'Heading 2'],
      ['h3', 'Heading 3'],
      ['h4', 'Heading 4'],
    ]) {
      const opt = doc.createElement('option');
      opt.value = val;
      opt.textContent = label;
      blockSelect.append(opt);
    }
    blockSelect.addEventListener('mousedown', (e) => e.stopPropagation());
    blockSelect.addEventListener('change', () => {
      const v = blockSelect.value;
      if (v === 'p') editor.chain().focus().setParagraph().run();
      else editor.chain().focus().setHeading({ level: Number(v[1]) }).run();
    });
    bubble.append(blockSelect);

    const refreshBlockSelect = () => {
      for (const level of [1, 2, 3, 4]) {
        if (editor.isActive('heading', { level })) {
          blockSelect.value = `h${level}`;
          return;
        }
      }
      blockSelect.value = 'p';
    };

    buttons.push(
      addBubbleButton(bubble, 'B', 'Bold (Cmd+B)',
        () => editor.chain().focus().toggleBold().run(),
        () => editor.isActive('bold')),
      addBubbleButton(bubble, 'I', 'Italic (Cmd+I)',
        () => editor.chain().focus().toggleItalic().run(),
        () => editor.isActive('italic')),
      addBubbleButton(bubble, '•', 'Bulleted list',
        () => editor.chain().focus().toggleBulletList().run(),
        () => editor.isActive('bulletList')),
      addBubbleButton(bubble, '1.', 'Numbered list',
        () => editor.chain().focus().toggleOrderedList().run(),
        () => editor.isActive('orderedList')),
      addBubbleButton(bubble, '🔗', 'Link (Cmd+K)',
        () => {
          const prev = editor.getAttributes('link').href || '';
          const next = win.prompt('URL', prev);
          if (next === null) return;
          if (next === '') editor.chain().focus().extendMarkRange('link').unsetLink().run();
          else editor.chain().focus().extendMarkRange('link').setLink({ href: next }).run();
        },
        () => editor.isActive('link')),
    );

    // Highlight active buttons on selection change.
    const refreshButtons = () => {
      for (const btn of buttons) {
        btn.style.background = btn._isActive() ? '#ffc400' : 'transparent';
        btn.style.color = btn._isActive() ? '#001' : '#fff';
      }
      refreshBlockSelect();
    };
    editor.on('selectionUpdate', refreshButtons);
    editor.on('transaction', refreshButtons);
    refreshButtons();

    currentTiptap = { editor, host, originalOuter, tag, file, loc, bubble };
  }

  // Build an Element from an HTML string. Used to restore the original DOM
  // when an edit is cancelled.
  function templateElement(html) {
    const tpl = doc.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild || doc.createTextNode(html);
  }

  // --- anchor edits (unchanged popover) ---------------------------------

  async function fetchRawHref(el) {
    const { file, loc } = sourceOf(el);
    try {
      const res = await fetchImpl('/__edit/href?' + new URLSearchParams({ file, loc }).toString(), {
        method: 'GET',
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json.raw;
    } catch {
      return null;
    }
  }

  async function saveAnchor(el, newText, newHref) {
    const { file, loc } = sourceOf(el);
    try {
      const res = await fetchImpl('/__edit/anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, loc, newText, newHref }),
      });
      if (!res.ok) {
        let err = {};
        try { err = await res.json(); } catch {}
        return { ok: false, error: err.error || res.statusText };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function closePopover() {
    if (currentPopover && currentPopover.parentNode) {
      currentPopover.parentNode.removeChild(currentPopover);
    }
    currentPopover = null;
  }

  function openAnchorPopover(a) {
    closePopover();
    const rect = a.getBoundingClientRect();
    const pop = doc.createElement('div');
    pop.className = 'edit-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Edit link');
    pop.style.cssText = `
      position: fixed;
      top: ${Math.round(rect.bottom + 6)}px;
      left: ${Math.round(rect.left)}px;
      z-index: 2147483600;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.18);
      padding: 10px;
      font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1a1a1a;
      min-width: 320px;
      display: grid;
      gap: 6px;
    `;

    const mkRow = (label, input) => {
      const row = doc.createElement('label');
      row.style.cssText = 'display:grid;gap:2px;font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.05em;';
      row.textContent = label;
      row.append(input);
      return row;
    };

    const textIn = doc.createElement('input');
    textIn.type = 'text';
    textIn.value = a.innerHTML;
    textIn.style.cssText = 'padding:5px 7px;border:1px solid #ddd;border-radius:4px;font:13px inherit;color:#1a1a1a;text-transform:none;letter-spacing:0;';

    const hrefIn = doc.createElement('input');
    hrefIn.type = 'text';
    hrefIn.value = 'loading…';
    hrefIn.disabled = true;
    hrefIn.style.cssText = textIn.style.cssText + 'font-family:ui-monospace,monospace;';

    const actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-top:2px;';
    const cancelBtn = doc.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:4px 10px;border:1px solid #ccc;background:#f6f6f8;border-radius:4px;cursor:pointer;font:inherit;';
    const saveBtn = doc.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'padding:4px 10px;border:1px solid #001888;background:#001888;color:#fff;border-radius:4px;cursor:pointer;font:inherit;';
    actions.append(cancelBtn, saveBtn);

    const errLine = doc.createElement('div');
    errLine.style.cssText = 'color:#c00;font-size:11px;min-height:0;';

    pop.append(mkRow('Text', textIn), mkRow('URL (raw source)', hrefIn), errLine, actions);
    doc.body.append(pop);
    currentPopover = pop;

    fetchRawHref(a).then((raw) => {
      if (pop !== currentPopover) return;
      hrefIn.disabled = false;
      hrefIn.value = raw != null ? raw : ('"' + a.getAttribute('href') + '"');
      textIn.focus();
      textIn.select();
    });

    const close = () => closePopover();
    const submit = async () => {
      saveBtn.disabled = true;
      errLine.textContent = '';
      const result = await saveAnchor(a, textIn.value, hrefIn.value);
      lastResults.push(result);
      if (!result.ok) {
        errLine.textContent = result.error;
        saveBtn.disabled = false;
        return;
      }
      close();
    };

    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', submit);
    pop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });

    const outside = (ev) => {
      if (currentPopover && !currentPopover.contains(ev.target)) {
        doc.removeEventListener('click', outside, true);
        close();
      }
    };
    setTimeout(() => {
      if (currentPopover) doc.addEventListener('click', outside, true);
    }, 0);
  }

  function onClick(e) {
    const closest = e.target.closest ? e.target.closest.bind(e.target) : null;
    if (!closest) return;

    // Clicks inside the currently open link popover — let them through.
    if (currentPopover && currentPopover.contains(e.target)) return;

    // Clicks inside the active Tiptap editor — let the browser handle them
    // (caret placement, link clicks, etc.). Don't start a new edit.
    if (closest('[' + ACTIVE_ATTR + ']')) return;

    // Clicks on the bubble menu (button toolbar) — let mousedown handlers
    // do their thing. Never treat this as "clicked away".
    if (closest('.edit-bubble-menu')) return;

    const anchor = closest('[' + ANCHOR_ATTR + ']');
    const textEl = closest('[' + TEXT_ATTR + ']');

    // If an editor is active and the click landed somewhere else, save first.
    if (currentTiptap && (anchor || textEl || true)) {
      closeTiptap({ cancel: false });
    }

    if (anchor) {
      e.preventDefault();
      e.stopPropagation();
      openAnchorPopover(anchor);
      return;
    }
    if (textEl) {
      e.preventDefault();
      e.stopPropagation();
      beginTextEdit(textEl);
    }
    // Clicks on non-editable parts of the page are left alone (no preventDefault).
  }

  function enable() {
    if (active) return;
    active = true;
    markEditable();
    clickHandler = onClick;
    doc.addEventListener('click', clickHandler, true);
    if (typeof win.MutationObserver === 'function') {
      mo = new win.MutationObserver(() => markEditable());
      mo.observe(doc.documentElement, { childList: true, subtree: true });
    }
  }

  function disable() {
    if (!active) return;
    active = false;
    if (clickHandler) doc.removeEventListener('click', clickHandler, true);
    clickHandler = null;
    if (mo) { mo.disconnect(); mo = null; }
    unmarkEditable();
  }

  return {
    enable,
    disable,
    _state: () => ({ active, editable: doc.querySelectorAll('[' + TEXT_ATTR + '], [' + ANCHOR_ATTR + ']').length }),
    _simulateClick: (el) => onClick({ target: el, preventDefault() {}, stopPropagation() {} }),
    _beginTextEdit: beginTextEdit,
    _currentPopover: () => currentPopover,
    _currentTiptap: () => currentTiptap,
    _lastResults: () => lastResults.slice(),
  };
}
