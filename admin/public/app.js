// Mental model:
//   - A "carousel" is a folder in public/images/ plus an entry in carousels.json.
//   - "pending" is a dumping ground, NOT a carousel.
//   - Images live in exactly one place. Dragging an image moves the file AND
//     updates carousels.json accordingly.
//   - Drag from pending onto a carousel  → adds the image to that carousel.
//   - Drag a carousel slide to pending   → removes it from that carousel.
//   - Drag within the slides list        → reorders.

const PENDING = 'pending';
const DRAG_MIME = 'application/x-image-ref';

const state = {
  carousels: {},   // { id: [{src, title, description?}] }  (from carousels.json)
  ids: [],         // sorted carousel folder ids (never includes pending)
  pending: [],     // filenames in public/images/pending/
  imagesByFolder: {},
  current: null,
  draft: null,
  dirty: false,
};

// --- DOM helpers --------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n[k] = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
};

let statusTimer = 0;
function setStatus(msg, kind = '') {
  const s = $('#status');
  s.textContent = msg;
  s.className = 'status ' + kind;
  clearTimeout(statusTimer);
  if (kind === 'ok') statusTimer = setTimeout(() => { if (s.textContent === msg) s.textContent = ''; }, 2500);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request failed');
  }
  return res.json();
}

// --- data loading -------------------------------------------------------

async function load() {
  const data = await api('GET', '/api/state');
  state.carousels = data.carousels;
  state.ids = data.ids;
  state.imagesByFolder = data.images;
  state.pending = data.images[PENDING] || [];
  renderSidebar();
  renderPending();
}

function buildDraft(id) {
  const files = new Set(state.imagesByFolder[id] || []);
  const draft = [];
  const meta = state.carousels[id] || [];
  for (const item of meta) {
    const name = item.src.split('/').pop();
    if (files.has(name)) {
      draft.push({ name, src: item.src, title: item.title, description: item.description || '' });
      files.delete(name);
    }
  }
  for (const name of [...files].sort()) {
    draft.push({ name, src: `/images/${id}/${name}`, title: '', description: '' });
  }
  return draft;
}

// --- sidebar ------------------------------------------------------------

function renderSidebar() {
  const list = $('#carousel-list');
  list.innerHTML = '';
  for (const id of state.ids) {
    const hasMeta = id in state.carousels;
    const count = (state.imagesByFolder[id] || []).length;
    const isActive = id === state.current;
    const li = el('li', {
      class: [
        isActive ? 'active' : '',
        hasMeta ? '' : 'no-metadata',
      ].filter(Boolean).join(' '),
      'data-id': id,
      title: hasMeta ? '' : 'Folder exists but no entry in carousels.json yet',
      onclick: () => selectCarousel(id),
      ondragenter: (e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        li.classList.add('drop-target');
      },
      ondragover: (e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      ondragleave: (e) => {
        if (!li.contains(e.relatedTarget)) li.classList.remove('drop-target');
      },
      ondrop: async (e) => {
        e.preventDefault();
        li.classList.remove('drop-target');
        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (!raw) return;
        const ref = JSON.parse(raw);
        if (ref.from === id) return;
        await moveImage({ from: ref.from, to: id, name: ref.name });
      },
    }, [
      el('span', { text: id }),
      el('span', { class: 'count', 'data-count': '', text: String(count) + (isActive && state.dirty ? ' •' : '') }),
    ]);
    list.append(li);
  }
}

function updateDirtyBadge() {
  document.querySelectorAll('#carousel-list li').forEach((li) => {
    const id = li.dataset.id;
    const isActive = id === state.current;
    li.classList.toggle('active', isActive);
    const count = (state.imagesByFolder[id] || []).length;
    const base = String(isActive && state.draft ? state.draft.length : count);
    li.querySelector('[data-count]').textContent = base + (isActive && state.dirty ? ' •' : '');
  });
}

// --- editor -------------------------------------------------------------

function selectCarousel(id) {
  if (state.dirty && !confirm('Unsaved changes will be lost. Continue?')) return;
  state.current = id;
  state.draft = buildDraft(id);
  state.dirty = false;
  $('#editor-empty').hidden = true;
  $('#editor').hidden = false;
  $('#editor-title').textContent = id;
  const hasMeta = id in state.carousels;
  $('#editor-subtitle').textContent = hasMeta
    ? `${state.draft.length} images. Drag to reorder. Drop here from Pending to add; drag a slide to Pending to remove.`
    : 'This folder has no carousels.json entry yet. Add titles and Save to create one.';
  renderSlides();
  updateDirtyBadge();
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    updateDirtyBadge();
  }
}

function moveSlide(from, to) {
  if (from === to) return;
  const [moved] = state.draft.splice(from, 1);
  state.draft.splice(to, 0, moved);
  markDirty();
  renderSlides();
}

function buildSlide(slide, i) {
  const atTop = i === 0;
  const atBottom = i === state.draft.length - 1;
  const li = el('li', {
    class: 'slide',
    draggable: 'true',
    'data-index': String(i),
  }, [
    el('div', { class: 'handle', text: '⋮⋮' }),
    el('div', { class: 'slide-thumb', onclick: () => openLightbox(slide.src) }, [
      el('img', { src: slide.src, alt: '', loading: 'lazy', decoding: 'async' }),
      el('div', { class: 'fname', text: slide.name }),
    ]),
    el('div', { class: 'fields' }, [
      el('input', {
        class: 'title',
        type: 'text',
        placeholder: 'Title',
        value: slide.title,
        oninput: (e) => { slide.title = e.target.value; markDirty(); },
      }),
      el('input', {
        type: 'text',
        placeholder: 'Description (optional)',
        value: slide.description,
        oninput: (e) => { slide.description = e.target.value; markDirty(); },
      }),
    ]),
    el('div', { class: 'order-actions' }, [
      el('button', {
        class: 'order-btn',
        title: 'Move to top',
        disabled: atTop ? '' : null,
        onclick: () => moveSlide(i, 0),
        html: '⤒',
      }),
      el('button', {
        class: 'order-btn',
        title: 'Move to bottom',
        disabled: atBottom ? '' : null,
        onclick: () => moveSlide(i, state.draft.length - 1),
        html: '⤓',
      }),
    ]),
  ]);

  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ from: state.current, name: slide.name }));
    li.classList.add('dragging');
  });
  li.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    const rect = li.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    li.classList.toggle('drag-over-top', above);
    li.classList.toggle('drag-over-bottom', !above);
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over-top', 'drag-over-bottom'));
  li.addEventListener('drop', (e) => {
    const above = li.classList.contains('drag-over-top');
    li.classList.remove('drag-over-top', 'drag-over-bottom');
    const fromIdx = Number(e.dataTransfer.getData('text/plain'));
    if (Number.isNaN(fromIdx)) return;
    e.preventDefault();
    let toIdx = Number(li.dataset.index);
    if (!above) toIdx += 1;
    if (fromIdx === toIdx || fromIdx === toIdx - 1) return;
    const [moved] = state.draft.splice(fromIdx, 1);
    const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
    state.draft.splice(insertAt, 0, moved);
    markDirty();
    renderSlides();
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom'));
  return li;
}

function renderSlides() {
  const list = $('#slides');
  const frag = document.createDocumentFragment();
  state.draft.forEach((s, i) => frag.append(buildSlide(s, i)));
  list.replaceChildren(frag);
  $('#slides-hint').hidden = state.draft.length > 0;
}

// Editor pane accepts drops from pending (add to carousel).
const editorPane = $('#editor-pane');
editorPane.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes(DRAG_MIME) || !state.current) return;
  e.preventDefault();
  editorPane.classList.add('drop-target');
});
editorPane.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes(DRAG_MIME) || !state.current) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
editorPane.addEventListener('dragleave', (e) => {
  if (!editorPane.contains(e.relatedTarget)) editorPane.classList.remove('drop-target');
});
editorPane.addEventListener('drop', async (e) => {
  editorPane.classList.remove('drop-target');
  const raw = e.dataTransfer.getData(DRAG_MIME);
  if (!raw || !state.current) return;
  e.preventDefault();
  const ref = JSON.parse(raw);
  if (ref.from === state.current) return;
  await moveImage({ from: ref.from, to: state.current, name: ref.name });
});

// --- pending rail -------------------------------------------------------

function renderPending() {
  $('#pending-count').textContent = state.pending.length;
  const grid = $('#pending-grid');
  grid.innerHTML = '';
  if (state.pending.length === 0) {
    grid.append(el('div', { class: 'pending-empty', text: 'No pending images.' }));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const name of state.pending) {
    const src = `/images/${PENDING}/${name}`;
    const thumb = el('div', {
      class: 'pending-thumb',
      draggable: 'true',
      title: name,
      onclick: () => openLightbox(src),
    }, [
      el('img', { src, loading: 'lazy', decoding: 'async', alt: '' }),
      el('div', { class: 'fname', text: name }),
    ]);
    thumb.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ from: PENDING, name }));
      thumb.classList.add('dragging');
    });
    thumb.addEventListener('dragend', () => thumb.classList.remove('dragging'));
    frag.append(thumb);
  }
  grid.append(frag);
}

// Pending rail accepts drops from slides (remove from carousel).
const pendingRail = $('#pending-rail');
pendingRail.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
  e.preventDefault();
  pendingRail.classList.add('drop-target');
});
pendingRail.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
pendingRail.addEventListener('dragleave', (e) => {
  if (!pendingRail.contains(e.relatedTarget)) pendingRail.classList.remove('drop-target');
});
pendingRail.addEventListener('drop', async (e) => {
  pendingRail.classList.remove('drop-target');
  const raw = e.dataTransfer.getData(DRAG_MIME);
  if (!raw) return;
  const ref = JSON.parse(raw);
  if (ref.from === PENDING) return;
  e.preventDefault();
  await moveImage({ from: ref.from, to: PENDING, name: ref.name });
});

// --- actions ------------------------------------------------------------

async function moveImage({ from, to, name, rename }) {
  try {
    await api('POST', '/api/move', { from, to, name, rename: rename || undefined });
    await load();
    if (state.current) {
      // If the user had unsaved edits, warn but discard them — the move
      // is now the authoritative state.
      state.draft = buildDraft(state.current);
      state.dirty = false;
      renderSlides();
      updateDirtyBadge();
    }
    setStatus(`Moved ${name} → ${to}/`, 'ok');
  } catch (err) {
    setStatus('Move failed: ' + err.message, 'err');
  }
}

async function save() {
  if (!state.current) return;
  const id = state.current;
  const body = state.draft.map((s) => {
    const out = { src: s.src, title: (s.title || '').trim() };
    if (s.description && s.description.trim()) out.description = s.description.trim();
    return out;
  });
  try {
    await api('PUT', `/api/carousels/${id}`, body);
    state.carousels[id] = JSON.parse(JSON.stringify(body));
    state.dirty = false;
    setStatus('Saved.', 'ok');
    updateDirtyBadge();
    $('#editor-subtitle').textContent = `${state.draft.length} images. Drag to reorder. Drop here from Pending to add; drag a slide to Pending to remove.`;
  } catch (err) {
    setStatus('Save failed: ' + err.message, 'err');
  }
}

async function addCarousel(e) {
  e.preventDefault();
  const input = $('#new-carousel-id');
  const id = input.value.trim();
  if (!id) return;
  try {
    await api('POST', '/api/carousels', { id });
    input.value = '';
    await load();
    selectCarousel(id);
    setStatus(`Created carousel "${id}".`, 'ok');
  } catch (err) {
    setStatus('Create failed: ' + err.message, 'err');
  }
}

// --- lightbox -----------------------------------------------------------

const lightbox = $('#lightbox');
lightbox.addEventListener('click', () => { lightbox.hidden = true; });
function openLightbox(src) {
  lightbox.querySelector('img').src = src;
  lightbox.hidden = false;
}

// --- tab manager --------------------------------------------------------

const tabs = {
  carousels: { body: $('#tab-carousels'), dirty: () => state.dirty },
  exposanten: { body: $('#tab-exposanten'), dirty: () => exposantenEditor.dirty },
  events: { body: $('#tab-events'), dirty: () => eventsEditor.dirty },
};
let currentTab = 'carousels';

function switchTab(name) {
  if (name === currentTab) return;
  if (tabs[currentTab].dirty() && !confirm('Unsaved changes in this tab will be lost. Continue?')) return;
  currentTab = name;
  for (const [k, t] of Object.entries(tabs)) t.body.hidden = k !== name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'exposanten' && !exposantenEditor.loaded) exposantenEditor.load();
  if (name === 'events' && !eventsEditor.loaded) eventsEditor.load();
}

document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => switchTab(b.dataset.tab);
});

// --- row editor factory (exposanten, events) ---------------------------------

function createRowEditor({ dataset, listEl, addBtn, saveBtn, blank, renderRow }) {
  const ed = {
    rows: [],
    dirty: false,
    loaded: false,
    async load() {
      try {
        ed.rows = await api('GET', `/api/data/${dataset}`);
        ed.dirty = false;
        ed.loaded = true;
        ed.render();
      } catch (err) {
        setStatus(`Load ${dataset} failed: ` + err.message, 'err');
      }
    },
    markDirty() {
      if (!ed.dirty) ed.dirty = true;
    },
    render() {
      const frag = document.createDocumentFragment();
      ed.rows.forEach((row, i) => frag.append(renderRow(row, i, ed)));
      listEl.replaceChildren(frag);
    },
    move(from, to) {
      if (to < 0 || to >= ed.rows.length || from === to) return;
      const [m] = ed.rows.splice(from, 1);
      ed.rows.splice(to, 0, m);
      ed.markDirty();
      ed.render();
    },
    remove(i) {
      if (!confirm('Delete this row?')) return;
      ed.rows.splice(i, 1);
      ed.markDirty();
      ed.render();
    },
    add() {
      ed.rows.push({ ...blank });
      ed.markDirty();
      ed.render();
    },
    async save() {
      try {
        await api('PUT', `/api/data/${dataset}`, ed.rows);
        ed.dirty = false;
        setStatus('Saved.', 'ok');
      } catch (err) {
        setStatus('Save failed: ' + err.message, 'err');
      }
    },
  };
  addBtn.onclick = () => ed.add();
  saveBtn.onclick = () => ed.save();
  return ed;
}

function rowActions(i, total, ed) {
  return el('div', { class: 'row-actions' }, [
    el('button', { title: 'Move up', disabled: i === 0 ? '' : null, onclick: () => ed.move(i, i - 1), html: '↑' }),
    el('button', { title: 'Move down', disabled: i === total - 1 ? '' : null, onclick: () => ed.move(i, i + 1), html: '↓' }),
    el('button', { class: 'delete', title: 'Delete', onclick: () => ed.remove(i), html: '×' }),
  ]);
}

function wrapSpan(labelEl, extraClass) {
  if (extraClass) labelEl.classList.add(extraClass);
  return labelEl;
}

function inputField(label, row, key, opts = {}, ed) {
  return el('label', { text: label }, [
    el(opts.tag || 'input', {
      type: opts.type || 'text',
      placeholder: opts.placeholder || '',
      value: row[key] || '',
      oninput: (e) => { row[key] = e.target.value; ed.markDirty(); },
      ...(opts.attrs || {}),
    }),
  ]);
}

function selectField(label, row, key, options, ed) {
  const sel = el('select', {
    onchange: (e) => { row[key] = e.target.value; ed.markDirty(); },
  });
  for (const opt of options) {
    const o = el('option', { value: opt.value, text: opt.label });
    if ((row[key] || '') === opt.value) o.selected = true;
    sel.append(o);
  }
  return el('label', { text: label }, [sel]);
}

// --- exposanten editor --------------------------------------------------

const EXPOSANT_CATEGORIES = [
  { value: 'organisator', label: 'organisator' },
  { value: 'aanwezig', label: 'ook aanwezig' },
];

const exposantenEditor = createRowEditor({
  dataset: 'exposanten',
  listEl: $('#exposanten-list'),
  addBtn: $('#exposanten-add'),
  saveBtn: $('#exposanten-save'),
  blank: { title: '', href: '', scale: '', description: '', category: 'organisator' },
  renderRow(row, i, ed) {
    return el('div', { class: 'row' }, [
      el('div', { class: 'row-body' }, [
        el('div', { class: 'row-grid cols-4' }, [
          inputField('Titel', row, 'title', { placeholder: 'Westfriese Modelspoor Club' }, ed),
          inputField('Href', row, 'href', { placeholder: '/exposanten/…' }, ed),
          selectField('Categorie', row, 'category', EXPOSANT_CATEGORIES, ed),
          inputField('Status', row, 'status', { placeholder: 'optioneel' }, ed),
        ]),
        el('div', { class: 'row-grid cols-3' }, [
          wrapSpan(inputField('Label', row, 'scale', { placeholder: 'H0 en N' }, ed), ''),
          wrapSpan(inputField('Afbeelding', row, 'image', { placeholder: '/images/exposanten/…' }, ed), 'span-2'),
        ]),
        el('div', { class: 'row-grid cols-2' }, [
          wrapSpan(inputField('Beschrijving', row, 'description', { tag: 'textarea', placeholder: 'Korte beschrijving' }, ed), 'span-full'),
        ]),
      ]),
      rowActions(i, ed.rows.length, ed),
    ]);
  },
});

// --- events editor ------------------------------------------------------

const EVENT_TYPES = [
  { value: 'nmd', label: 'Modelspoordagen' },
  { value: 'expositie', label: 'expositie' },
  { value: 'opendag', label: 'opendag' },
  { value: 'beurs', label: 'beurs' },
];

const eventsEditor = createRowEditor({
  dataset: 'events',
  listEl: $('#events-list'),
  addBtn: $('#events-add'),
  saveBtn: $('#events-save'),
  blank: { date: '', title: '', type: 'expositie' },
  renderRow(row, i, ed) {
    return el('div', { class: 'row' }, [
      el('div', { class: 'row-body' }, [
        el('div', { class: 'row-grid cols-4' }, [
          inputField('Titel', row, 'title', { placeholder: 'Noord-Hollandse Modelspoordagen' }, ed),
          selectField('Type', row, 'type', EVENT_TYPES, ed),
          inputField('Locatie', row, 'location', { placeholder: 'Alkmaar' }, ed),
          inputField('Link', row, 'link', { placeholder: '/bezoek of https://…' }, ed),
        ]),
        el('div', { class: 'row-grid cols-4' }, [
          inputField('Startdatum', row, 'date', { type: 'date' }, ed),
          inputField('Einddatum', row, 'endDate', { type: 'date' }, ed),
          inputField('Starttijd', row, 'startTime', { type: 'time' }, ed),
          inputField('Eindtijd', row, 'endTime', { type: 'time' }, ed),
        ]),
        el('div', { class: 'row-grid cols-2' }, [
          wrapSpan(inputField('Beschrijving', row, 'description', { tag: 'textarea', placeholder: 'Toelichting (optioneel)' }, ed), 'span-full'),
        ]),
      ]),
      rowActions(i, ed.rows.length, ed),
    ]);
  },
});

// --- global keys --------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.hidden) lightbox.hidden = true;
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (currentTab === 'carousels' && state.dirty) save();
    else if (currentTab === 'exposanten' && exposantenEditor.dirty) exposantenEditor.save();
    else if (currentTab === 'events' && eventsEditor.dirty) eventsEditor.save();
  }
});

// --- wire up ------------------------------------------------------------

$('#save-btn').onclick = save;
$('#new-carousel-form').onsubmit = addCarousel;

window.addEventListener('beforeunload', (e) => {
  if (state.dirty || exposantenEditor.dirty || eventsEditor.dirty) {
    e.preventDefault(); e.returnValue = '';
  }
});

load().catch((err) => setStatus('Load failed: ' + err.message, 'err'));
