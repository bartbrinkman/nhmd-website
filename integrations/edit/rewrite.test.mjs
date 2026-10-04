// Tests for the dev-toolbar edit integration. Run with `npm run test:edit`.
//
// Covers every known failure mode observed while building this tool,
// so we don't regress on the same issues again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineColToOffset, rewriteTag, parseOpeningTagEnd, findAttributeValueBounds, rewriteAnchor, readAnchorHref, rewriteBlock, cleanTiptapHtml, reshapeOuterForSave } from './rewrite.mjs';

// --- lineColToOffset ----------------------------------------------------

test('lineColToOffset: first char is line 1 col 1', () => {
  assert.equal(lineColToOffset('hello', 1, 1), 0);
});

test('lineColToOffset: mid-line on line 1', () => {
  assert.equal(lineColToOffset('hello', 1, 3), 2); // 'l'
});

test('lineColToOffset: first char of line 2', () => {
  assert.equal(lineColToOffset('a\nbcd', 2, 1), 2);
});

test('lineColToOffset: col past end of line returns position', () => {
  assert.equal(lineColToOffset('ab\ncd', 1, 3), 2); // the '\n'
});

test('lineColToOffset: EOF position is valid', () => {
  const src = 'abc';
  assert.equal(lineColToOffset(src, 1, 4), 3);
});

test('lineColToOffset: out of range returns -1', () => {
  assert.equal(lineColToOffset('abc', 5, 1), -1);
  assert.equal(lineColToOffset('abc', 0, 1), -1);
  assert.equal(lineColToOffset('abc', 1, 0), -1);
});

test('lineColToOffset: multi-byte chars count as one char (JS string indexing)', () => {
  const src = 'héllo'; // 'é' = 1 code unit in UTF-16
  assert.equal(lineColToOffset(src, 1, 3), 2); // 'l'
});

// --- parseOpeningTagEnd -------------------------------------------------

test('parseOpeningTagEnd: simple tag', () => {
  const src = '<p>hi';
  assert.equal(parseOpeningTagEnd(src, 0), 2); // > is at index 2
});

test('parseOpeningTagEnd: with attributes', () => {
  const src = '<p class="foo">hi';
  assert.equal(parseOpeningTagEnd(src, 0), 14);
});

test('parseOpeningTagEnd: attribute value contains `>`', () => {
  const src = '<p data-x="a>b">hi';
  assert.equal(parseOpeningTagEnd(src, 0), 15);
});

test('parseOpeningTagEnd: attribute value contains `<`', () => {
  const src = '<p data-x="a<b">hi';
  assert.equal(parseOpeningTagEnd(src, 0), 15);
});

test('parseOpeningTagEnd: JSX braces in attribute', () => {
  const src = '<p class={cx("a", "b")}>hi';
  assert.equal(parseOpeningTagEnd(src, 0), 23);
});

test('parseOpeningTagEnd: nested braces in attribute', () => {
  const src = '<p data={{x: 1}}>hi';
  assert.equal(parseOpeningTagEnd(src, 0), 16);
});

test('parseOpeningTagEnd: self-closing tag', () => {
  const src = '<br />';
  assert.equal(parseOpeningTagEnd(src, 0), 5);
});

test('parseOpeningTagEnd: unterminated returns -1', () => {
  assert.equal(parseOpeningTagEnd('<p class="unterminated', 0), -1);
});

test('parseOpeningTagEnd: wrong start char returns -1', () => {
  assert.equal(parseOpeningTagEnd('p>', 0), -1);
});

// --- rewriteTag: happy paths --------------------------------------------

// Helper: given a source string, find where the content of the first `<tag>`
// begins (i.e. the char right after the opening-tag `>`). Mimics what Astro's
// dev-toolbar source-loc gives us. Uses the real tag parser so attribute
// values containing `>` are handled correctly.
function contentOffsetOf(src, tag) {
  const re = new RegExp('<' + tag + '[\\s>/]', 'i');
  const m = re.exec(src);
  if (!m) throw new Error(`no <${tag}> in fixture`);
  const gt = parseOpeningTagEnd(src, m.index);
  if (gt < 0) throw new Error(`could not find end of <${tag}> opening`);
  return gt + 1;
}

test('rewriteTag: simple <h2> replacement', () => {
  const src = '  <h2>Hello</h2>\n';
  const r = rewriteTag(src, contentOffsetOf(src, 'h2'), 'h2', 'World');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '  <h2>World</h2>\n');
});

test('rewriteTag: <p> spanning multiple lines', () => {
  const src = '<p>\n  Hello\n  world\n</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'New text');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p>New text</p>');
});

test('rewriteTag: preserves file content outside the edited tag', () => {
  const src = '---\nconst x = 1;\n---\n<p>Old</p>\n<h1>Keep me</h1>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'New');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '---\nconst x = 1;\n---\n<p>New</p>\n<h1>Keep me</h1>');
});

test('rewriteTag: works with attributes on the opening tag', () => {
  const src = '<h2 class="foo" id="bar">Title</h2>';
  const r = rewriteTag(src, contentOffsetOf(src, 'h2'), 'h2', 'Updated');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<h2 class="foo" id="bar">Updated</h2>');
});

test('rewriteTag: handles attribute values containing `>`', () => {
  const src = '<p data-x="a>b">Hello</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'New');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p data-x="a>b">New</p>');
});

test('rewriteTag: handles attribute values containing `<`', () => {
  const src = '<p data-x="a<b">Hello</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'New');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p data-x="a<b">New</p>');
});

test('rewriteTag: overwrites inner with nested tags as plain text (by design)', () => {
  const src = '<p>Hello <strong>world</strong>!</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'Plain replacement');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p>Plain replacement</p>');
});

// --- rewriteTag: Astro's loc is content-start, not tag-start ------------

test('rewriteTag: regression — loc points at content-start, not `<`', () => {
  // Astro's data-astro-source-loc gives the content start. Fixture simulates
  // `<h2>Wie zijn wij?</h2>` at line 7 col 3; loc="7:7" points at 'W'.
  const src = '---\nimport X from "y";\n---\n\n\n\n  <h2>Wie zijn wij?</h2>\n';
  const offset = lineColToOffset(src, 7, 7);
  assert.ok(offset > 0, 'offset must be positive');
  assert.equal(src[offset], 'W'); // sanity check
  const r = rewriteTag(src, offset, 'h2', 'Over ons');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '---\nimport X from "y";\n---\n\n\n\n  <h2>Over ons</h2>\n');
});

test('rewriteTag: tolerates whitespace between `>` and content', () => {
  const src = '<p>   Hello   </p>';
  // Astro could place loc at first content char 'H'.
  const offset = src.indexOf('Hello');
  const r = rewriteTag(src, offset, 'p', 'New');
  assert.ok(r.ok, r.error);
  // All whitespace gets replaced along with content since innerStart is at 'H'…
  // Actually innerStart is the offset we were given; whitespace before is preserved.
  assert.equal(r.out, '<p>   New</p>');
});

// --- rewriteTag: tag-name validation -----------------------------------

test('rewriteTag: rejects when tag name mismatches source', () => {
  const src = '<p>Hello</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'h2', 'New');
  assert.equal(r.ok, false);
  assert.match(r.error, /expected <h2>/);
});

test('rewriteTag: is case-insensitive on tag name', () => {
  const src = '<P>Hello</P>';
  const r = rewriteTag(src, contentOffsetOf(src, 'P'), 'p', 'World');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<P>World</P>');
});

// --- rewriteTag: expression guard ---------------------------------------

test('rewriteTag: refuses element containing `{expr}`', () => {
  const src = '<p>{event.description}</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'Anything');
  assert.equal(r.ok, false);
  assert.match(r.error, /expression/);
});

test('rewriteTag: refuses mixed static + expression inner', () => {
  const src = '<p>Prefix {expr} suffix</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'New');
  assert.equal(r.ok, false);
  assert.match(r.error, /expression/);
});

test('rewriteTag: allows inner with only braces in attribute (not in inner)', () => {
  // The guard only looks at inner. Attributes can contain {expr} safely.
  const src = '<p class={cx("a", "b")}>Hello</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'New');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p class={cx("a", "b")}>New</p>');
});

// --- rewriteTag: nesting ------------------------------------------------

test('rewriteTag: handles nested same-tag (<p> inside <p> is unusual but possible)', () => {
  const src = '<p>outer <p>inner</p> more</p>';
  const outerOffset = contentOffsetOf(src, 'p');
  const r = rewriteTag(src, outerOffset, 'p', 'replaced');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p>replaced</p>');
});

test('rewriteTag: rewriting an inner <h2> does not consume outer', () => {
  const src = '<section><h2>First</h2><h2>Second</h2></section>';
  // Target the first h2 — offset is just after `<h2>`
  const firstH2 = src.indexOf('First');
  const r = rewriteTag(src, firstH2, 'h2', 'Changed');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<section><h2>Changed</h2><h2>Second</h2></section>');
});

// --- rewriteTag: error cases --------------------------------------------

test('rewriteTag: missing closing tag returns error', () => {
  const src = '<p>Hello';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'New');
  assert.equal(r.ok, false);
  assert.match(r.error, /closing tag/);
});

test('rewriteTag: offset before any `>` returns error', () => {
  const src = 'no tags here';
  const r = rewriteTag(src, 5, 'p', 'New');
  assert.equal(r.ok, false);
});

test('rewriteTag: offset out of range returns error', () => {
  const src = '<p>Hi</p>';
  const r = rewriteTag(src, 9999, 'p', 'New');
  assert.equal(r.ok, false);
});

test('rewriteTag: negative offset returns error', () => {
  const r = rewriteTag('<p>Hi</p>', -1, 'p', 'New');
  assert.equal(r.ok, false);
});

// --- rewriteTag: unicode + HTML entities --------------------------------

test('rewriteTag: preserves unicode in source outside the tag', () => {
  const src = '<p>Hello</p>\n// émoji 🎉 comment';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'Hi');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p>Hi</p>\n// émoji 🎉 comment');
});

test('rewriteTag: new content can contain HTML entities and special chars', () => {
  const src = '<p>old</p>';
  const r = rewriteTag(src, contentOffsetOf(src, 'p'), 'p', 'A &amp; B < C > D');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p>A &amp; B < C > D</p>');
});

// --- end-to-end: real-looking Astro page --------------------------------

// --- cleanTiptapHtml ----------------------------------------------------

test('cleanTiptapHtml: unwraps <li><p>…</p></li> → <li>…</li>', () => {
  const input = '<ul><li><p>One</p></li><li><p>Two</p></li></ul>';
  assert.equal(cleanTiptapHtml(input), '<ul><li>One</li><li>Two</li></ul>');
});

test('cleanTiptapHtml: strips trailing empty <p> selection anchor', () => {
  const input = '<ul><li>One</li></ul><p></p>';
  assert.equal(cleanTiptapHtml(input), '<ul><li>One</li></ul>');
});

test('cleanTiptapHtml: strips ProseMirror trailing <br>', () => {
  const input = '<ul><li>One</li></ul><p><br class="ProseMirror-trailingBreak"></p>';
  assert.equal(cleanTiptapHtml(input), '<ul><li>One</li></ul>');
});

test('cleanTiptapHtml: real-world Tiptap output from <ul> edit matches expected shape', () => {
  const input = [
    '<ul>',
    '<li><p>Historisch stationsgebouw van Alkmaar met voetgangersbrug</p></li>',
    '<li><p>Draaibrug over het Noordhollands Kanaal</p></li>',
    '<li><p>Klapbrug over het kanaal Alkmaar-Kolhorn</p></li>',
    '</ul>',
    '<p><br class="ProseMirror-trailingBreak"></p>',
  ].join('');
  const cleaned = cleanTiptapHtml(input);
  assert.equal(cleaned, [
    '<ul>',
    '<li>Historisch stationsgebouw van Alkmaar met voetgangersbrug</li>',
    '<li>Draaibrug over het Noordhollands Kanaal</li>',
    '<li>Klapbrug over het kanaal Alkmaar-Kolhorn</li>',
    '</ul>',
  ].join(''));
});

test('cleanTiptapHtml: leaves non-list content alone', () => {
  const input = '<p>Just a paragraph.</p>';
  assert.equal(cleanTiptapHtml(input), '<p>Just a paragraph.</p>');
});

test('cleanTiptapHtml: preserves <li> with inline formatting (does not mangle)', () => {
  const input = '<ul><li><p>Hello <strong>bold</strong> text</p></li></ul>';
  assert.equal(cleanTiptapHtml(input), '<ul><li>Hello <strong>bold</strong> text</li></ul>');
});

test('cleanTiptapHtml: does NOT unwrap when <li> has multiple children', () => {
  // Tiptap only produces one <p> per <li> from our config, but guard anyway.
  const input = '<ul><li><p>First</p><p>Second</p></li></ul>';
  assert.equal(cleanTiptapHtml(input), '<ul><li><p>First</p><p>Second</p></li></ul>');
});

test('cleanTiptapHtml: multiline <li><p> with whitespace still unwraps', () => {
  const input = '<ul>\n  <li>\n    <p>Nested</p>\n  </li>\n</ul>';
  // Inner whitespace is preserved but <p> wrapper is gone.
  assert.match(cleanTiptapHtml(input), /<li>\s*Nested\s*<\/li>/);
  assert.doesNotMatch(cleanTiptapHtml(input), /<p>/);
});

test('cleanTiptapHtml: ordered lists get the same treatment', () => {
  const input = '<ol><li><p>Step 1</p></li><li><p>Step 2</p></li></ol>';
  assert.equal(cleanTiptapHtml(input), '<ol><li>Step 1</li><li>Step 2</li></ol>');
});

// --- rewriteBlock -------------------------------------------------------

function contentOffsetFor(src, tag) {
  const re = new RegExp('<' + tag + '[\\s>/]', 'i');
  const m = re.exec(src);
  if (!m) throw new Error(`no <${tag}>`);
  return parseOpeningTagEnd(src, m.index) + 1;
}

test('rewriteBlock: replaces entire <p> with new outer', () => {
  const src = '<p>Old</p>';
  const r = rewriteBlock(src, contentOffsetFor(src, 'p'), 'p', '<p>New</p>');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p>New</p>');
});

test('rewriteBlock: preserves surrounding content', () => {
  const src = '---\nimport X from "y";\n---\n<h2>Title</h2>\n<p>Old</p>\n<span>after</span>';
  const r = rewriteBlock(src, contentOffsetFor(src, 'p'), 'p', '<p>New</p>');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '---\nimport X from "y";\n---\n<h2>Title</h2>\n<p>New</p>\n<span>after</span>');
});

test('rewriteBlock: <ul> edit can add / remove <li>s (pretty-prints to match .astro style)', () => {
  const src = '<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>';
  const r = rewriteBlock(src, contentOffsetFor(src, 'ul'), 'ul', '<ul><li>One</li><li>Two</li><li>Three</li></ul>');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<ul><li>One</li><li>Two</li><li>Three</li></ul>');
});

test('rewriteBlock: tag mismatch is rejected', () => {
  const src = '<p>hi</p>';
  const r = rewriteBlock(src, contentOffsetFor(src, 'p'), 'h2', '<h2>x</h2>');
  assert.equal(r.ok, false);
  assert.match(r.error, /expected <h2>/);
});

test('rewriteBlock: refuses if inner contains Astro expression', () => {
  const src = '<p>{title}</p>';
  const r = rewriteBlock(src, contentOffsetFor(src, 'p'), 'p', '<p>new</p>');
  assert.equal(r.ok, false);
  assert.match(r.error, /expression/);
});

test('rewriteBlock: nested <ul> inside <ul> is handled via depth counter', () => {
  const src = '<ul><li>a<ul><li>nested</li></ul></li></ul>';
  const r = rewriteBlock(src, contentOffsetFor(src, 'ul'), 'ul', '<ul><li>flat</li></ul>');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<ul><li>flat</li></ul>');
});

test('rewriteBlock: newly-added content can include inline markup', () => {
  const src = '<p>Old</p>';
  const r = rewriteBlock(src, contentOffsetFor(src, 'p'), 'p', '<p>With <strong>bold</strong> text</p>');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<p>With <strong>bold</strong> text</p>');
});

// --- findAttributeValueBounds -------------------------------------------

function parseTag(src) {
  const lt = src.indexOf('<');
  const gt = parseOpeningTagEnd(src, lt);
  return { lt, gt };
}

test('findAttributeValueBounds: double-quoted value', () => {
  const src = '<a href="/x">Hi</a>';
  const { lt, gt } = parseTag(src);
  const b = findAttributeValueBounds(src, lt, gt, 'href');
  assert.ok(b);
  assert.equal(src.slice(b.valueStart, b.valueEnd), '"/x"');
});

test('findAttributeValueBounds: single-quoted value', () => {
  const src = "<a href='/x'>Hi</a>";
  const { lt, gt } = parseTag(src);
  const b = findAttributeValueBounds(src, lt, gt, 'href');
  assert.equal(src.slice(b.valueStart, b.valueEnd), "'/x'");
});

test('findAttributeValueBounds: JSX expression value', () => {
  const src = '<a href={asset("/x")}>Hi</a>';
  const { lt, gt } = parseTag(src);
  const b = findAttributeValueBounds(src, lt, gt, 'href');
  assert.equal(src.slice(b.valueStart, b.valueEnd), '{asset("/x")}');
});

test('findAttributeValueBounds: nested braces in expression', () => {
  const src = '<a href={{x: 1}}>Hi</a>';
  const { lt, gt } = parseTag(src);
  const b = findAttributeValueBounds(src, lt, gt, 'href');
  assert.equal(src.slice(b.valueStart, b.valueEnd), '{{x: 1}}');
});

test('findAttributeValueBounds: expression containing `>` character', () => {
  const src = '<a href={a > b ? "/y" : "/n"}>Hi</a>';
  const { lt, gt } = parseTag(src);
  const b = findAttributeValueBounds(src, lt, gt, 'href');
  assert.equal(src.slice(b.valueStart, b.valueEnd), '{a > b ? "/y" : "/n"}');
});

test('findAttributeValueBounds: picks the correct attribute when multiple exist', () => {
  const src = '<a class="foo" href="/x" target="_blank">Hi</a>';
  const { lt, gt } = parseTag(src);
  const b = findAttributeValueBounds(src, lt, gt, 'href');
  assert.equal(src.slice(b.valueStart, b.valueEnd), '"/x"');
});

test('findAttributeValueBounds: missing attribute returns null', () => {
  const src = '<a class="foo">Hi</a>';
  const { lt, gt } = parseTag(src);
  assert.equal(findAttributeValueBounds(src, lt, gt, 'href'), null);
});

test('findAttributeValueBounds: is case-insensitive on attribute name', () => {
  const src = '<a HREF="/x">Hi</a>';
  const { lt, gt } = parseTag(src);
  const b = findAttributeValueBounds(src, lt, gt, 'href');
  assert.equal(src.slice(b.valueStart, b.valueEnd), '"/x"');
});

test('findAttributeValueBounds: does NOT match a longer attribute with href as prefix', () => {
  const src = '<a hreflang="en" href="/x">Hi</a>';
  const { lt, gt } = parseTag(src);
  const b = findAttributeValueBounds(src, lt, gt, 'href');
  assert.equal(src.slice(b.valueStart, b.valueEnd), '"/x"');
});

// --- readAnchorHref -----------------------------------------------------

function anchorOffset(src) {
  const re = /<a[\s>]/i;
  const m = re.exec(src);
  if (!m) throw new Error('no anchor');
  return parseOpeningTagEnd(src, m.index) + 1;
}

test('readAnchorHref: quoted href', () => {
  const src = '<a href="/agenda">Agenda</a>';
  const r = readAnchorHref(src, anchorOffset(src));
  assert.deepEqual(r, { ok: true, raw: '"/agenda"' });
});

test('readAnchorHref: asset-wrapped href', () => {
  const src = '<a href={asset("/agenda")}>Agenda</a>';
  const r = readAnchorHref(src, anchorOffset(src));
  assert.deepEqual(r, { ok: true, raw: '{asset("/agenda")}' });
});

test('readAnchorHref: tag without href returns error', () => {
  const src = '<a>just text</a>';
  const r = readAnchorHref(src, anchorOffset(src));
  assert.equal(r.ok, false);
});

test('readAnchorHref: not an <a> tag returns error', () => {
  const src = '<p href="/x">notlink</p>';
  const offset = src.indexOf('notlink');
  const r = readAnchorHref(src, offset);
  assert.equal(r.ok, false);
});

// --- rewriteAnchor ------------------------------------------------------

test('rewriteAnchor: rewrites both text and href (quoted → quoted)', () => {
  const src = '<a href="/old">Old text</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'New text', '"/new"');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a href="/new">New text</a>');
});

test('rewriteAnchor: preserves other attributes and their order', () => {
  const src = '<a class="btn" href="/old" target="_blank" rel="noopener">Old</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'New', '"/new"');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a class="btn" href="/new" target="_blank" rel="noopener">New</a>');
});

test('rewriteAnchor: asset() wrapper preserved when user submits it', () => {
  const src = '<a href={asset("/a")}>A</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'B', '{asset("/b")}');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a href={asset("/b")}>B</a>');
});

test('rewriteAnchor: user can switch from quoted to expression form', () => {
  const src = '<a href="/a">A</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'A', '{asset("/a")}');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a href={asset("/a")}>A</a>');
});

test('rewriteAnchor: user can switch from expression to plain string', () => {
  const src = '<a href={asset("/a")}>A</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'A', '"/static-url"');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a href="/static-url">A</a>');
});

test('rewriteAnchor: external https URL', () => {
  const src = '<a href="https://old.example">Old</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'Bahnwelt', '"https://www.bahnwelt.de"');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a href="https://www.bahnwelt.de">Bahnwelt</a>');
});

test('rewriteAnchor: tag without href rejects', () => {
  const src = '<a>text only</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'x', '"/y"');
  assert.equal(r.ok, false);
  assert.match(r.error, /href/);
});

test('rewriteAnchor: refuses if inner contains expression', () => {
  const src = '<a href="/x">{label}</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'x', '"/y"');
  assert.equal(r.ok, false);
  assert.match(r.error, /expression/);
});

test('rewriteAnchor: applied to one of two adjacent anchors only affects that one', () => {
  const src = '<a href="/a">A</a> — <a href="/b">B</a>';
  const offsetA = src.indexOf('>A') + 1;
  const r = rewriteAnchor(src, offsetA, 'AA', '"/aa"');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a href="/aa">AA</a> — <a href="/b">B</a>');
});

test('rewriteAnchor: preserves content outside the anchor', () => {
  const src = '---\nimport X from "y";\n---\n<p>hi <a href="/old">link</a> there</p>';
  const offset = src.indexOf('>link') + 1;
  const r = rewriteAnchor(src, offset, 'link', '"/new"');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '---\nimport X from "y";\n---\n<p>hi <a href="/new">link</a> there</p>');
});

test('rewriteAnchor: tag name mismatch (targeting a <span>)', () => {
  const src = '<span href="/x">text</span>';
  const offset = src.indexOf('text');
  const r = rewriteAnchor(src, offset, 'x', '"/y"');
  assert.equal(r.ok, false);
  assert.match(r.error, /expected <a>/);
});

test('rewriteAnchor: anchor with title attr containing `>`', () => {
  const src = '<a title="x > y" href="/x">Hi</a>';
  const r = rewriteAnchor(src, anchorOffset(src), 'Bye', '"/z"');
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a title="x > y" href="/z">Bye</a>');
});

test('rewriteAnchor: full round-trip via readAnchorHref', () => {
  const src = '<a href={asset("/agenda")}>Volledige agenda →</a>';
  const offset = anchorOffset(src);
  const read = readAnchorHref(src, offset);
  assert.equal(read.raw, '{asset("/agenda")}');
  // User sees `{asset("/agenda")}`, edits text to "Open de agenda"
  const r = rewriteAnchor(src, offset, 'Open de agenda', read.raw);
  assert.ok(r.ok, r.error);
  assert.equal(r.out, '<a href={asset("/agenda")}>Open de agenda</a>');
});

test('rewriteTag: edits a real-looking Astro page', () => {
  const src = [
    '---',
    'import Page from \'../layouts/Page.astro\';',
    '---',
    '',
    '<Page title="De Club">',
    '  <h2>Wie zijn wij?</h2>',
    '  <p>We zijn een club.</p>',
    '  <h2>Lid worden</h2>',
    '</Page>',
  ].join('\n');

  // Simulate Astro giving us loc "6:7" for the first h2 — "W" of "Wie"
  const offset1 = lineColToOffset(src, 6, 7);
  assert.equal(src[offset1], 'W');
  const r1 = rewriteTag(src, offset1, 'h2', 'Over ons');
  assert.ok(r1.ok, r1.error);

  // And "8:7" for the second h2
  const offset2 = lineColToOffset(r1.out, 8, 7);
  assert.equal(r1.out[offset2], 'L');
  const r2 = rewriteTag(r1.out, offset2, 'h2', 'Word lid');
  assert.ok(r2.ok, r2.error);

  assert.match(r2.out, /<h2>Over ons<\/h2>/);
  assert.match(r2.out, /<h2>Word lid<\/h2>/);
  assert.match(r2.out, /<p>We zijn een club\.<\/p>/);
});

// --- reshapeOuterForSave ------------------------------------------------
//
// Bubble-menu heading-level changes rely on this: we keep the original tag
// for the rewriteBlock safety check, but the content Tiptap emits may be a
// different heading level (or paragraph). These tests lock in that the user's
// choice wins for p/h* blocks, while lists can't accidentally change tag.

test('reshapeOuterForSave: paragraph kept as paragraph', () => {
  assert.equal(reshapeOuterForSave('p', '<p>hello</p>'), '<p>hello</p>');
});

test('reshapeOuterForSave: user changed h2 → h1 (new tag wins)', () => {
  assert.equal(reshapeOuterForSave('h2', '<h1>Title</h1>'), '<h1>Title</h1>');
});

test('reshapeOuterForSave: user changed h3 → paragraph', () => {
  assert.equal(reshapeOuterForSave('h3', '<p>just text</p>'), '<p>just text</p>');
});

test('reshapeOuterForSave: user changed p → h2', () => {
  assert.equal(reshapeOuterForSave('p', '<h2>Promoted</h2>'), '<h2>Promoted</h2>');
});

test('reshapeOuterForSave: heading with attrs is still recognized', () => {
  assert.equal(
    reshapeOuterForSave('h2', '<h1 class="x">Title</h1>'),
    '<h1 class="x">Title</h1>'
  );
});

test('reshapeOuterForSave: <ul> keeps ul even if content is already a <ul>', () => {
  assert.equal(
    reshapeOuterForSave('ul', '<ul><li>a</li></ul>'),
    '<ul><li>a</li></ul>'
  );
});

test('reshapeOuterForSave: <ol> output preserved when original was <ol>', () => {
  assert.equal(
    reshapeOuterForSave('ol', '<ol><li>a</li></ol>'),
    '<ol><li>a</li></ol>'
  );
});

test('reshapeOuterForSave: list fallback when Tiptap emits bare content', () => {
  // Defensive path — if Tiptap gave us something that doesn't start with a
  // list tag, wrap it so the saved source stays a list.
  assert.equal(
    reshapeOuterForSave('ul', '<li>a</li>'),
    '<ul><li>a</li></ul>'
  );
});

test('reshapeOuterForSave: p fallback when content has no recognized outer tag', () => {
  // Shouldn't happen in practice — Tiptap always wraps in a block — but if it
  // somehow returns bare text, don't silently drop the tag.
  assert.equal(
    reshapeOuterForSave('p', 'bare text'),
    '<p>bare text</p>'
  );
});

test('reshapeOuterForSave: does not mistake a span/div prefix for a block', () => {
  // Regression guard: the regex must match only p / h1-h6 at the top level.
  assert.equal(
    reshapeOuterForSave('p', '<span>x</span>'),
    '<p><span>x</span></p>'
  );
});

