// Pure functions for the edit integration. Kept separate for testing.

export const EDITABLE_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

// Given Tiptap's cleaned HTML output and the original block's tag, return the
// HTML string to send to rewriteBlock as `newOuter`. Rules:
//   - Lists (<ul>/<ol>) keep their tag. If Tiptap didn't produce a list (e.g.
//     content got transformed), wrap with the original tag.
//   - For p/h1-h6, trust whatever top-level p/h* Tiptap produced (the user
//     may have changed the heading level via the bubble-menu dropdown). If
//     Tiptap produced something else, fall back to wrapping in the original tag.
export function reshapeOuterForSave(tag, newContent) {
  if (tag === 'ul' || tag === 'ol') {
    return /^<(ul|ol)[\s>]/i.test(newContent) ? newContent : `<${tag}>${newContent}</${tag}>`;
  }
  if (/^<(p|h[1-6])(?:\s|>)/i.test(newContent)) return newContent;
  return `<${tag}>${newContent}</${tag}>`;
}

// Clean Tiptap's getHTML output before it hits disk:
//   - Drop trailing empty <p> selection anchors (<p></p>, <p><br ...></p>).
//   - Unwrap single <p> children inside <li> so list items stay as plain text.
//   - Strip Tiptap-internal helper classes (e.g. ProseMirror-trailingBreak).
export function cleanTiptapHtml(html) {
  let out = html;

  out = out.replace(/\s*<br\s+class="ProseMirror-trailingBreak"[^>]*>\s*/gi, '');

  // Repeatedly strip trailing empty <p>…</p> blocks.
  let prev;
  do {
    prev = out;
    out = out.replace(/<p>\s*<\/p>\s*$/i, '').trim();
  } while (out !== prev);

  // Unwrap <li><p>text</p></li>  →  <li>text</li>. Only when the <li> contains
  // exactly one <p> and nothing else. The inner must not itself contain </p>.
  out = out.replace(/<li>\s*<p>((?:(?!<\/?p[\s>]).)*?)<\/p>\s*<\/li>/gis, (_m, inner) => `<li>${inner}</li>`);

  return out;
}

// Within a slice of source starting at `<tag` and ending at `>`, find the
// bounds of the value portion of the named attribute. Returns
// { valueStart, valueEnd } with absolute offsets into the full source, or
// null if the attribute isn't present. The value bounds include the
// surrounding quotes or `{…}` so the caller can overwrite the whole thing.
//
// Handles:
//   name="foo"      → valueStart = index of `"`, valueEnd = index AFTER closing `"`
//   name='foo'      → same for `'`
//   name={expr}     → valueStart = index of `{`, valueEnd = index AFTER matching `}`
//   name            → (boolean attr) — not matched, returns null since there's no value to replace
export function findAttributeValueBounds(src, ltIndex, gtIndex, attrName) {
  // Scan only within the opening tag, respecting the same quote/brace state.
  let i = ltIndex + 1;
  let quote = null;
  let brace = 0;
  const lowerAttr = attrName.toLowerCase();
  while (i < gtIndex) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (brace > 0) {
      if (ch === '{') brace++;
      else if (ch === '}') brace--;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === '{') { brace++; i++; continue; }

    // Look for `attrName` as a word followed by `=`.
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < gtIndex && /[a-zA-Z0-9_:-]/.test(src[j])) j++;
      const name = src.slice(i, j).toLowerCase();
      // Skip whitespace
      let k = j;
      while (k < gtIndex && /\s/.test(src[k])) k++;
      if (name === lowerAttr && src[k] === '=') {
        // Found it. Skip `=` and optional whitespace.
        let v = k + 1;
        while (v < gtIndex && /\s/.test(src[v])) v++;
        if (src[v] === '"' || src[v] === "'") {
          const q = src[v];
          const end = src.indexOf(q, v + 1);
          if (end < 0 || end >= gtIndex) return null;
          return { valueStart: v, valueEnd: end + 1 };
        }
        if (src[v] === '{') {
          // Match braces
          let depth = 1;
          let m = v + 1;
          let vq = null;
          while (m < gtIndex && depth > 0) {
            const mc = src[m];
            if (vq) {
              if (mc === vq) vq = null;
            } else if (mc === '"' || mc === "'") {
              vq = mc;
            } else if (mc === '{') {
              depth++;
            } else if (mc === '}') {
              depth--;
            }
            m++;
          }
          if (depth !== 0) return null;
          return { valueStart: v, valueEnd: m };
        }
        // Unquoted attribute value (rare in JSX/astro but legal in raw HTML)
        let u = v;
        while (u < gtIndex && !/\s/.test(src[u]) && src[u] !== '>') u++;
        if (u === v) return null;
        return { valueStart: v, valueEnd: u };
      }
      i = j;
      continue;
    }
    i++;
  }
  return null;
}

// Replace the entire outer element (opening tag + inner + closing tag) whose
// content starts at `offset`. `newOuter` must be valid HTML (an element).
// Unlike rewriteTag this preserves nothing about the original element — the
// caller is expected to produce a reasonable replacement.
//
// The caller still specifies `tag` as a safety check: we only rewrite if the
// element at `offset` matches. This prevents a stale (line,col) accidentally
// overwriting the wrong element after a file edit.
export function rewriteBlock(src, offset, tag, newOuter) {
  const innerStart = offset;
  if (innerStart < 0 || innerStart > src.length) return { ok: false, error: 'offset out of range' };

  let gt = innerStart - 1;
  while (gt > 0 && /\s/.test(src[gt])) gt--;
  if (src[gt] !== '>') return { ok: false, error: 'did not find end of opening tag before loc' };

  let lt = -1;
  for (let k = gt - 1; k >= 0; k--) {
    if (src[k] !== '<') continue;
    if (src[k + 1] === '!' || src[k + 1] === '/') continue;
    if (!/[a-zA-Z]/.test(src[k + 1] || '')) continue;
    if (parseOpeningTagEnd(src, k) === gt) { lt = k; break; }
  }
  if (lt < 0) return { ok: false, error: 'opening tag start not found' };

  const opener = src.slice(lt, gt + 1);
  const tagMatch = opener.match(/^<\s*([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagMatch || tagMatch[1].toLowerCase() !== tag.toLowerCase()) {
    return { ok: false, error: `expected <${tag}>, found ${opener.slice(0, 40)}` };
  }

  const closeTag = '</' + tag;
  const lower = src.toLowerCase();
  const tagLen = tag.length;
  let depth = 0;
  let j = innerStart;
  while (j < src.length) {
    if (lower.startsWith('<' + tag, j) && /[\s>/]/.test(src[j + 1 + tagLen] || '')) {
      depth++;
      j += 1 + tagLen;
      continue;
    }
    if (lower.startsWith(closeTag, j)) {
      if (depth === 0) break;
      depth--;
      j += closeTag.length;
      continue;
    }
    j++;
  }
  if (j >= src.length) return { ok: false, error: 'closing tag not found' };
  // Advance past `</tag>`
  const closeStart = j;
  let closeEnd = j + closeTag.length;
  while (closeEnd < src.length && src[closeEnd] !== '>') closeEnd++;
  if (closeEnd >= src.length) return { ok: false, error: 'unterminated closing tag' };
  const elementEnd = closeEnd + 1;

  // Refuse if the current inner contains an Astro expression — same policy as rewriteTag.
  const currentInner = src.slice(innerStart, closeStart);
  if (/[{}]/.test(currentInner)) {
    return { ok: false, error: 'element contains an expression; edit source directly' };
  }

  return { ok: true, out: src.slice(0, lt) + newOuter + src.slice(elementEnd) };
}

// Read the raw `href` attribute source (quotes/braces included) for the
// `<a>` whose content starts at `offset`. Returns { ok, raw } or { ok:false, error }.
export function readAnchorHref(src, offset) {
  const innerStart = offset;
  if (innerStart < 0 || innerStart > src.length) return { ok: false, error: 'offset out of range' };
  let gt = innerStart - 1;
  while (gt > 0 && /\s/.test(src[gt])) gt--;
  if (src[gt] !== '>') return { ok: false, error: 'did not find end of opening tag' };
  let lt = -1;
  for (let k = gt - 1; k >= 0; k--) {
    if (src[k] !== '<') continue;
    if (src[k + 1] === '!' || src[k + 1] === '/') continue;
    if (!/[a-zA-Z]/.test(src[k + 1] || '')) continue;
    if (parseOpeningTagEnd(src, k) === gt) { lt = k; break; }
  }
  if (lt < 0) return { ok: false, error: 'opening tag start not found' };
  const opener = src.slice(lt, gt + 1);
  const tagMatch = opener.match(/^<\s*([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagMatch || tagMatch[1].toLowerCase() !== 'a') {
    return { ok: false, error: 'expected <a>' };
  }
  const bounds = findAttributeValueBounds(src, lt, gt, 'href');
  if (!bounds) return { ok: false, error: 'href not found' };
  return { ok: true, raw: src.slice(bounds.valueStart, bounds.valueEnd) };
}

// Rewrite both the inner HTML and the `href` attribute of an `<a>` tag
// whose content starts at `offset` (Astro's data-astro-source-loc style).
// `newHref` is injected verbatim as the attribute value — the caller is
// responsible for including the quotes / braces, matching the source style.
// Examples:
//   newHref === '"/foo"'            → href="/foo"
//   newHref === "'/foo'"            → href='/foo'
//   newHref === '{asset("/foo")}'   → href={asset("/foo")}
export function rewriteAnchor(src, offset, newInnerHtml, newHrefRaw) {
  const innerStart = offset;
  if (innerStart < 0 || innerStart > src.length) return { ok: false, error: 'offset out of range' };

  // Find the `>` ending the opening <a> tag (tolerate whitespace before content).
  let gt = innerStart - 1;
  while (gt > 0 && /\s/.test(src[gt])) gt--;
  if (src[gt] !== '>') return { ok: false, error: 'did not find end of opening tag before loc' };

  // Find matching `<` via forward verification.
  let lt = -1;
  for (let k = gt - 1; k >= 0; k--) {
    if (src[k] !== '<') continue;
    if (src[k + 1] === '!' || src[k + 1] === '/') continue;
    if (!/[a-zA-Z]/.test(src[k + 1] || '')) continue;
    if (parseOpeningTagEnd(src, k) === gt) { lt = k; break; }
  }
  if (lt < 0) return { ok: false, error: 'opening tag start not found' };

  const opener = src.slice(lt, gt + 1);
  const tagMatch = opener.match(/^<\s*([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagMatch || tagMatch[1].toLowerCase() !== 'a') {
    return { ok: false, error: `expected <a>, found ${opener.slice(0, 40)}` };
  }

  // Find matching `</a>` accounting for potential nesting (invalid HTML, but possible).
  const lower = src.toLowerCase();
  let depth = 0;
  let j = innerStart;
  while (j < src.length) {
    if (lower.startsWith('<a', j) && /[\s>/]/.test(src[j + 2] || '')) {
      depth++; j += 2; continue;
    }
    if (lower.startsWith('</a', j)) {
      if (depth === 0) break;
      depth--; j += 3; continue;
    }
    j++;
  }
  if (j >= src.length) return { ok: false, error: 'closing tag not found' };
  const innerEnd = j;

  // Refuse edits where inner contains an expression — matches rewriteTag behavior.
  const currentInner = src.slice(innerStart, innerEnd);
  if (/[{}]/.test(currentInner)) {
    return { ok: false, error: 'element contains an expression; edit source directly' };
  }

  // Locate href inside the opening tag.
  const hrefBounds = findAttributeValueBounds(src, lt, gt, 'href');
  if (!hrefBounds) return { ok: false, error: 'href attribute not found on <a>' };

  // Apply both edits in one pass (href first since it's earlier in the source).
  let out = src.slice(0, hrefBounds.valueStart)
    + newHrefRaw
    + src.slice(hrefBounds.valueEnd, innerStart)
    + newInnerHtml
    + src.slice(innerEnd);

  return { ok: true, out };
}

// Given `ltIndex` pointing at a `<`, scan forward through the opening tag
// (including any attributes) and return the index of the matching `>`.
// Respects double- and single-quoted attribute values and `{…}` expressions.
// Returns -1 if no matching `>` is found.
export function parseOpeningTagEnd(src, ltIndex) {
  if (src[ltIndex] !== '<') return -1;
  let i = ltIndex + 1;
  let quote = null;
  let brace = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      brace++;
    } else if (ch === '}') {
      if (brace > 0) brace--;
    } else if (ch === '>' && brace === 0) {
      return i;
    }
    i++;
  }
  return -1;
}

// Convert a 1-based (line, col) into a byte offset in `src`.
// Returns -1 if the position is out of range.
export function lineColToOffset(src, line, col) {
  if (line < 1 || col < 1) return -1;
  let l = 1, c = 1;
  for (let i = 0; i < src.length; i++) {
    if (l === line && c === col) return i;
    if (src[i] === '\n') { l++; c = 1; } else { c++; }
  }
  return l === line && c === col ? src.length : -1;
}

// Rewrite inner HTML of a `<tag>` whose inner content starts at `offset`.
// `offset` is Astro's `data-astro-source-loc` — the character right after the `>` of the opening tag.
//
// Returns { ok: true, out } on success, or { ok: false, error } on failure.
//
// Failure cases (intentional):
//   - Opening-tag character preceding `offset` is not `>` (with tolerant whitespace scan).
//   - The backward scan for the matching `<` fails.
//   - The discovered tag name doesn't match the requested `tag`.
//   - The closing `</tag>` is not found.
//   - The current inner content contains `{` or `}` (Astro expression).
export function rewriteTag(src, offset, tag, newHtml) {
  const innerStart = offset;
  if (innerStart < 0 || innerStart > src.length) return { ok: false, error: 'offset out of range' };

  // Expect the char right before `innerStart` to be `>`. Tolerate whitespace
  // (Astro's loc sometimes lands on the first non-whitespace content char).
  let gt = innerStart - 1;
  while (gt > 0 && /\s/.test(src[gt])) gt--;
  if (src[gt] !== '>') return { ok: false, error: 'did not find end of opening tag before loc' };

  // Find the matching `<` of this opening tag. Walking backward has to deal
  // with quoted attribute values that may contain `<` or `>`; that's tricky
  // because we don't know where quoted regions start until we've passed them.
  //
  // Simpler + correct: find candidate `<` positions by scanning backward,
  // then forward-parse each candidate to see if it lands exactly on our `>`.
  let lt = -1;
  for (let k = gt - 1; k >= 0; k--) {
    if (src[k] !== '<') continue;
    // Skip comments and closers that can't be opening tags.
    if (src[k + 1] === '!' || src[k + 1] === '/') continue;
    // Must look like `<tagname…`
    if (!/[a-zA-Z]/.test(src[k + 1] || '')) continue;
    // Forward-parse from k, respecting quotes/braces. If we reach exactly `gt`, it's our match.
    const fwdEnd = parseOpeningTagEnd(src, k);
    if (fwdEnd === gt) { lt = k; break; }
  }
  if (lt < 0) return { ok: false, error: 'opening tag start not found' };

  const opener = src.slice(lt, gt + 1);
  const tagMatch = opener.match(/^<\s*([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagMatch || tagMatch[1].toLowerCase() !== tag.toLowerCase()) {
    return { ok: false, error: `expected <${tag}>, found ${opener.slice(0, 40)}` };
  }

  // Scan forward for the matching `</tag>`, tracking nested same-named tags.
  const closeTag = '</' + tag;
  const lower = src.toLowerCase();
  const tagLen = tag.length;
  let depth = 0;
  let j = innerStart;
  while (j < src.length) {
    if (lower.startsWith('<' + tag, j) && /[\s>/]/.test(src[j + 1 + tagLen] || '')) {
      depth++;
      j += 1 + tagLen;
      continue;
    }
    if (lower.startsWith(closeTag, j)) {
      if (depth === 0) break;
      depth--;
      j += closeTag.length;
      continue;
    }
    j++;
  }
  if (j >= src.length) return { ok: false, error: 'closing tag not found' };
  const innerEnd = j;

  const currentInner = src.slice(innerStart, innerEnd);
  if (/[{}]/.test(currentInner)) {
    return { ok: false, error: 'element contains an expression; edit source directly' };
  }

  return { ok: true, out: src.slice(0, innerStart) + newHtml + src.slice(innerEnd) };
}
