// jsdom-based tests for the client-side edit plumbing.
//
// Scope after the Tiptap migration:
//   - Text editing behavior (focus/blur/Enter/Backspace, contenteditable) is
//     owned by Tiptap and NOT tested here. We test our own plumbing:
//       - marking: which elements get `data-editable` / `data-editable-anchor`
//       - source attr snapshot fallback (Astro Audit regression)
//       - anchor popover flow (still fully custom)
//       - cleanup on disable()

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEditor, EDITABLE } from './client.mjs';

function pageWithTags(body) {
  return new JSDOM(
    `<!doctype html><html><head></head><body>${body}</body></html>`,
    { url: 'http://localhost:4321/' }
  );
}

function recordingFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function anchorFetch({ raw = '"/old"' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    if (typeof url === 'string' && url.startsWith('/__edit/href')) {
      return { ok: true, status: 200, json: async () => ({ raw }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// --- marking ------------------------------------------------------------

test('enable() marks editable text tags that have source info and are text-leaves', () => {
  const dom = pageWithTags(`
    <h1 data-astro-source-file="/x.astro" data-astro-source-loc="1:1">Title</h1>
    <h2 data-astro-source-file="/x.astro" data-astro-source-loc="2:1">Sub</h2>
    <p data-astro-source-file="/x.astro" data-astro-source-loc="3:1">Para</p>
    <h3>no source attrs</h3>
    <section data-astro-source-file="/x.astro" data-astro-source-loc="4:1">non-editable tag</section>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  const marked = dom.window.document.querySelectorAll('[data-editable]');
  assert.equal(marked.length, 3);
});

test('footer-style text divs/spans are editable when leaf', () => {
  const dom = pageWithTags(`
    <footer>
      <div data-astro-source-file="/layout.astro" data-astro-source-loc="1:1">Koornlaan 23</div>
      <span data-astro-source-file="/layout.astro" data-astro-source-loc="2:1">inline</span>
    </footer>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  assert.equal(dom.window.document.querySelectorAll('[data-editable]').length, 2);
});

test('<li> elements are NOT marked individually — their parent <ul>/<ol> is the edit unit', () => {
  const dom = pageWithTags(`
    <ul data-astro-source-file="/x.astro" data-astro-source-loc="1:1">
      <li data-astro-source-file="/x.astro" data-astro-source-loc="2:1">One</li>
      <li data-astro-source-file="/x.astro" data-astro-source-loc="3:1">Two</li>
    </ul>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  const doc = dom.window.document;
  assert.equal(doc.querySelector('ul').getAttribute('data-editable'), '');
  assert.equal(doc.querySelectorAll('li[data-editable]').length, 0, '<li> not marked');
});

test('<ul> not editable if any <li> has nested non-inline content', () => {
  const dom = pageWithTags(`
    <ul data-astro-source-file="/x.astro" data-astro-source-loc="1:1">
      <li data-astro-source-file="/x.astro" data-astro-source-loc="2:1">Fine</li>
      <li data-astro-source-file="/x.astro" data-astro-source-loc="3:1"><div>Nested block</div></li>
    </ul>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  assert.equal(dom.window.document.querySelectorAll('[data-editable]').length, 0);
});

test('paragraph containing only inline elements (<a>, <strong>, <br>) IS a text-leaf', () => {
  const dom = pageWithTags(`
    <p data-astro-source-file="/x.astro" data-astro-source-loc="1:1">
      hi <strong>there</strong><br>new line with <a href="/x" data-astro-source-file="/x.astro" data-astro-source-loc="1:20">link</a>.
    </p>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: anchorFetch() });
  ed.enable();
  assert.equal(dom.window.document.querySelector('p').getAttribute('data-editable'), '');
  // Anchor inside the editable paragraph is NOT marked — Tiptap's bubble menu
  // owns link editing inside text blocks.
  assert.equal(dom.window.document.querySelectorAll('[data-editable-anchor]').length, 0);
});

test('standalone <a> in <main>/page content IS marked', () => {
  const dom = pageWithTags(`
    <main>
      <a href="https://example.com" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">External</a>
    </main>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: anchorFetch() });
  ed.enable();
  assert.equal(dom.window.document.querySelectorAll('[data-editable-anchor]').length, 1);
});

test('elements inside <header> are skipped (out of scope)', () => {
  const dom = pageWithTags(`
    <header>
      <a href="/" data-astro-source-file="/layout.astro" data-astro-source-loc="1:1">Logo</a>
      <p data-astro-source-file="/layout.astro" data-astro-source-loc="2:1">Site title</p>
    </header>
    <main>
      <p data-astro-source-file="/x.astro" data-astro-source-loc="5:1">Page content</p>
    </main>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: anchorFetch() });
  ed.enable();
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('[data-editable]').length, 1);
  assert.equal(doc.querySelector('[data-editable]').textContent.trim(), 'Page content');
  assert.equal(doc.querySelectorAll('[data-editable-anchor]').length, 0);
});

test('wrapper <div>s with child block elements are NOT marked', () => {
  const dom = pageWithTags(`
    <div class="wrapper" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">
      <p data-astro-source-file="/x.astro" data-astro-source-loc="2:1">Inside</p>
    </div>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  const marked = dom.window.document.querySelectorAll('[data-editable]');
  assert.equal(marked.length, 1);
  assert.equal(marked[0].tagName, 'P');
});

test('elements inside the toolbar root are not marked', () => {
  const dom = pageWithTags(`
    <astro-dev-toolbar>
      <p data-astro-source-file="/x.astro" data-astro-source-loc="1:1">toolbar internal</p>
    </astro-dev-toolbar>
    <p data-astro-source-file="/x.astro" data-astro-source-loc="2:1">page content</p>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  const marked = dom.window.document.querySelectorAll('[data-editable]');
  assert.equal(marked.length, 1);
  assert.equal(marked[0].textContent, 'page content');
});

test('enable/disable are idempotent', () => {
  const dom = pageWithTags(`<p data-astro-source-file="/x.astro" data-astro-source-loc="1:1">a</p>`);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable(); ed.enable();
  assert.equal(ed._state().active, true);
  ed.disable(); ed.disable();
  assert.equal(ed._state().active, false);
});

test('disable() removes all marking', () => {
  const dom = pageWithTags(`
    <p data-astro-source-file="/x.astro" data-astro-source-loc="1:1">a</p>
    <a href="/x" data-astro-source-file="/x.astro" data-astro-source-loc="2:1">link</a>
  `);
  const doc = dom.window.document;
  const ed = createEditor(doc, { win: dom.window, fetchImpl: anchorFetch() });
  ed.enable();
  ed.disable();
  assert.equal(doc.querySelectorAll('[data-editable]').length, 0);
  assert.equal(doc.querySelectorAll('[data-editable-anchor]').length, 0);
});

test('click handler is removed after disable()', () => {
  const dom = pageWithTags(`<p data-astro-source-file="/x.astro" data-astro-source-loc="1:1">a</p>`);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  ed.disable();
  // Post-disable click should be a no-op; no contenteditable, no popover, no tiptap.
  const p = dom.window.document.querySelector('p');
  p.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(ed._currentTiptap(), null);
});

// --- regression: Astro Audit strips data-astro-source-* -----------------

test('regression: marks elements that only have snapshot attrs (data-edit-src-*)', () => {
  const dom = pageWithTags(`
    <h2 data-edit-src-file="/pages/x.astro" data-edit-src-loc="3:1">Survived audit</h2>
    <p data-edit-src-file="/pages/x.astro" data-edit-src-loc="4:1">Also snapshotted</p>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  assert.equal(dom.window.document.querySelectorAll('[data-editable]').length, 2);
});

test('regression: element with NO source info is not editable', () => {
  const dom = pageWithTags(`<p>Lost both attrs</p>`);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  assert.equal(dom.window.document.querySelectorAll('[data-editable]').length, 0);
});

// --- MutationObserver re-marking ----------------------------------------

test('dynamically inserted editable elements get marked after HMR-like swap', async () => {
  const dom = pageWithTags(`<p data-astro-source-file="/x.astro" data-astro-source-loc="1:1">Initial</p>`);
  const doc = dom.window.document;
  const ed = createEditor(doc, { win: dom.window, fetchImpl: recordingFetch() });
  ed.enable();
  const newH2 = doc.createElement('h2');
  newH2.setAttribute('data-astro-source-file', '/x.astro');
  newH2.setAttribute('data-astro-source-loc', '5:1');
  newH2.textContent = 'Added later';
  doc.body.append(newH2);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(newH2.getAttribute('data-editable'), '');
});

// --- anchor editing -----------------------------------------------------

test('enable() marks <a> elements with source info', () => {
  const dom = pageWithTags(`
    <a href="/x" data-astro-source-file="/x.astro" data-astro-source-loc="10:3">link</a>
    <a href="/y">no source</a>
  `);
  const ed = createEditor(dom.window.document, { win: dom.window, fetchImpl: anchorFetch() });
  ed.enable();
  const marked = dom.window.document.querySelectorAll('[data-editable-anchor]');
  assert.equal(marked.length, 1);
  assert.equal(marked[0].getAttribute('href'), '/x');
});

test('clicking an editable anchor opens the popover', () => {
  const dom = pageWithTags(`<a href="/old" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">Old</a>`);
  const doc = dom.window.document;
  const ed = createEditor(doc, { win: dom.window, fetchImpl: anchorFetch({ raw: '"/old"' }) });
  ed.enable();
  doc.querySelector('a').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const pop = ed._currentPopover();
  assert.ok(pop);
  assert.equal(pop.getAttribute('role'), 'dialog');
  const inputs = pop.querySelectorAll('input');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].value, 'Old');
});

test('popover href input loads the raw source value from server', async () => {
  const dom = pageWithTags(`<a href="/resolved" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">x</a>`);
  const doc = dom.window.document;
  const fetchImpl = anchorFetch({ raw: '{asset("/agenda")}' });
  const ed = createEditor(doc, { win: dom.window, fetchImpl });
  ed.enable();
  ed._simulateClick(doc.querySelector('a'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const hrefIn = ed._currentPopover().querySelectorAll('input')[1];
  assert.equal(hrefIn.value, '{asset("/agenda")}');
  assert.equal(hrefIn.disabled, false);
});

test('popover falls back to attribute href if raw-read fails', async () => {
  const dom = pageWithTags(`<a href="/fallback" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">x</a>`);
  const doc = dom.window.document;
  const fetchImpl = async (url) => {
    if (url.startsWith('/__edit/href')) return { ok: false, status: 400, json: async () => ({ error: 'nope' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const ed = createEditor(doc, { win: dom.window, fetchImpl });
  ed.enable();
  ed._simulateClick(doc.querySelector('a'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const hrefIn = ed._currentPopover().querySelectorAll('input')[1];
  assert.equal(hrefIn.value, '"/fallback"');
});

test('popover Save POSTs correct payload to /__edit/anchor', async () => {
  const dom = pageWithTags(`<a href="/old" data-astro-source-file="/pages/x.astro" data-astro-source-loc="4:5">Old</a>`);
  const doc = dom.window.document;
  const fetchImpl = anchorFetch({ raw: '"/old"' });
  const ed = createEditor(doc, { win: dom.window, fetchImpl });
  ed.enable();
  ed._simulateClick(doc.querySelector('a'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const pop = ed._currentPopover();
  const inputs = pop.querySelectorAll('input');
  inputs[0].value = 'New text';
  inputs[1].value = '"/new"';
  const buttons = pop.querySelectorAll('button');
  buttons[buttons.length - 1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const call = fetchImpl.calls.find((c) => c.url === '/__edit/anchor');
  assert.ok(call);
  assert.deepEqual(call.body, {
    file: '/pages/x.astro',
    loc: '4:5',
    newText: 'New text',
    newHref: '"/new"',
  });
  assert.equal(ed._currentPopover(), null);
});

test('popover Cancel closes without POSTing', () => {
  const dom = pageWithTags(`<a href="/x" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">x</a>`);
  const doc = dom.window.document;
  const fetchImpl = anchorFetch();
  const ed = createEditor(doc, { win: dom.window, fetchImpl });
  ed.enable();
  ed._simulateClick(doc.querySelector('a'));
  const cancelBtn = ed._currentPopover().querySelectorAll('button')[0];
  cancelBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(ed._currentPopover(), null);
  const posts = fetchImpl.calls.filter((c) => c.init?.method === 'POST');
  assert.equal(posts.length, 0);
});

test('popover Escape closes', () => {
  const dom = pageWithTags(`<a href="/x" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">x</a>`);
  const doc = dom.window.document;
  const ed = createEditor(doc, { win: dom.window, fetchImpl: anchorFetch() });
  ed.enable();
  ed._simulateClick(doc.querySelector('a'));
  ed._currentPopover().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(ed._currentPopover(), null);
});

test('popover server rejection shows error and stays open', async () => {
  const dom = pageWithTags(`<a href="/x" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">x</a>`);
  const doc = dom.window.document;
  const fetchImpl = async (url) => {
    if (url.startsWith('/__edit/href')) return { ok: true, json: async () => ({ raw: '"/x"' }) };
    return { ok: false, status: 400, json: async () => ({ error: 'href not found' }) };
  };
  const ed = createEditor(doc, { win: dom.window, fetchImpl });
  ed.enable();
  ed._simulateClick(doc.querySelector('a'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const pop = ed._currentPopover();
  pop.querySelectorAll('button')[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(ed._currentPopover());
  assert.match(pop.textContent, /href not found/);
});

test('disable() closes any open popover', () => {
  const dom = pageWithTags(`<a href="/x" data-astro-source-file="/x.astro" data-astro-source-loc="1:1">x</a>`);
  const doc = dom.window.document;
  const ed = createEditor(doc, { win: dom.window, fetchImpl: anchorFetch() });
  ed.enable();
  ed._simulateClick(doc.querySelector('a'));
  assert.ok(ed._currentPopover());
  ed.disable();
  assert.equal(ed._currentPopover(), null);
});
