// Injected into the active tab by popup.js through chrome.scripting.executeScript.
// Chrome serializes this function, so everything it uses must be defined inside it.
function extractPage(options) {
  const opts = Object.assign({ scope: 'main', meta: true, links: true, images: true }, options);

  const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object',
    'embed', 'video', 'audio', 'source', 'track', 'map', 'input', 'select', 'textarea',
    'button', 'link', 'meta', 'head', 'dialog',
  ]);
  const BLOCK = new Set([
    'address', 'article', 'aside', 'blockquote', 'caption', 'details', 'dd', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ]);
  const BLOCK_SELECTOR = [...BLOCK].join(',');
  const INLINE = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font',
    'i', 'img', 'ins', 'kbd', 'label', 'mark', 'math', 'picture', 'q', 's', 'samp', 'small', 'span',
    'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  ]);
  const NOISE_TAGS = new Set(['nav', 'aside', 'footer', 'form']);
  const NOISE_ROLES = /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|menu|menubar)$/;
  const NOISE_NAMES = /(^|[\s_-])(comments?|sidebar|share|sharing|social|related|promo|advert|ads|cookies?|consent|newsletter|breadcrumbs?|menu|navbar|subscribe|popup|modal|toc|editsection)([\s_-]|$)/i;
  const SCREEN_READER_ONLY = /(^|\s)(sr-only|visually-hidden|visuallyhidden|screen-reader-text)(\s|$)/;
  // Formula containers: native MathML, KaTeX and Wikipedia (hidden MathML + fallback image).
  const MATH_SELECTOR = 'math, .katex, .mwe-math-element';

  // Errors are returned as codes: popup.js shows them in the chosen language.
  if (!document.body) return { error: 'noBody' };

  const clean = (s) => s
    .replace(/[​-‍﻿]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

  const oneLine = (s) => clean(s).replace(/\n/g, ' ');

  const isHidden = (el) => {
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  };

  const paragraphLength = (el) => {
    let length = 0;
    for (const p of el.querySelectorAll('p')) length += p.textContent.trim().length;
    return length;
  };

  const describe = (el) => (el === document.body
    ? 'body'
    : el.localName + (el.id ? `#${el.id}` : '') + [...el.classList].slice(0, 2).map((c) => `.${c}`).join(''));

  function findMainRoot() {
    const body = document.body;
    const total = paragraphLength(body);
    if (total < 200) {
      const el = document.querySelector('main, [role="main"], article');
      return el && !isHidden(el) ? el : body;
    }

    // Smallest semantic container that still holds most of the paragraph text.
    let best = null;
    const candidates = document.querySelectorAll(
      'article, main, [role="main"], [itemprop="articleBody"], .post-content, .entry-content, '
      + '.article-content, .article-body, .post-body, .mw-parser-output, #content, #main-content'
    );
    for (const el of candidates) {
      if (isHidden(el) || paragraphLength(el) < total * 0.6) continue;
      if (!best || el.textContent.length < best.textContent.length) best = el;
    }
    if (best) return best;

    // No semantic container: score the parents of paragraphs instead.
    const scores = new Map();
    for (const p of body.querySelectorAll('p')) {
      const length = p.textContent.trim().length;
      if (length < 25) continue;
      const parent = p.parentElement;
      const grandparent = parent && parent.parentElement;
      if (parent) scores.set(parent, (scores.get(parent) || 0) + length);
      if (grandparent) scores.set(grandparent, (scores.get(grandparent) || 0) + length / 2);
    }
    let top = body;
    let topScore = 0;
    for (const [el, score] of scores) {
      if (score > topScore) {
        top = el;
        topScore = score;
      }
    }
    return paragraphLength(top) >= total * 0.4 ? top : body;
  }

  let root;
  if (opts.scope === 'selection') {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return { error: 'noSelection' };
    root = document.createElement('div');
    for (let i = 0; i < selection.rangeCount; i++) root.append(selection.getRangeAt(i).cloneContents());
  } else {
    root = opts.scope === 'page' ? document.body : findMainRoot();
  }

  const useParagraphs = paragraphLength(root) >= 200;
  const weight = (el) => (useParagraphs ? paragraphLength(el) : el.textContent.length);
  const rootWeight = weight(root);

  function isNoise(el) {
    const tag = el.localName;
    const role = el.getAttribute('role');
    const looksLikeNoise = NOISE_TAGS.has(tag)
      || (tag === 'header' && !el.parentElement.closest('article, main, [role="main"]'))
      || (role && NOISE_ROLES.test(role))
      || NOISE_NAMES.test(`${el.getAttribute('class') || ''} ${el.id}`);
    // Never drop a wrapper that holds most of the content, whatever it is called.
    return looksLikeNoise && weight(el) < rootWeight * 0.3;
  }

  const skipCache = new WeakMap();
  function skip(el) {
    let skipped = skipCache.get(el);
    if (skipped === undefined) {
      skipped = SKIP.has(el.localName)
        || SCREEN_READER_ONLY.test(el.getAttribute('class') || '')
        || (opts.scope === 'main' && el !== root && isNoise(el))
        || isHidden(el);
      skipCache.set(el, skipped);
    }
    return skipped;
  }

  // Parentheses and spaces would end a Markdown link destination early.
  const escapeUrl = (url) => url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');

  const pageUrl = location.href.split('#')[0];
  function linkTarget(a) {
    const href = a.href;
    if (typeof href !== 'string' || !/^(https?:|mailto:|tel:)/.test(href)) return null;
    if (href.includes('#') && href.split('#')[0] === pageUrl) return null; // in-page anchors
    return escapeUrl(href);
  }

  // LaTeX of a formula container, from its TeX annotation or Wikipedia's fallback image.
  function mathOf(el) {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    const fallback = el.querySelector('img[alt]');
    let tex = (annotation ? annotation.textContent : (fallback && fallback.getAttribute('alt')) || el.getAttribute('alttext') || '').trim();
    const displaystyle = /^\{\\displaystyle\s*([\s\S]*)\}$/.exec(tex);
    if (displaystyle) tex = displaystyle[1].trim();
    if (!tex) return null;
    const isBlock = el.matches('math[display="block"]') || !!el.querySelector('math[display="block"]') || !!el.closest('.katex-display');
    return { tex: tex.replace(/\s+/g, ' '), isBlock };
  }

  // Puts Markdown markers around the text while keeping its surrounding spaces outside them.
  function wrap(text, before, after = before) {
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return core ? `${lead}${before}${core}${after}${trail}` : text;
  }

  // Inline Markdown of a subtree: source whitespace collapses, <br> and block boundaries become
  // line breaks. `plain` drops the formatting (used for headings).
  function inline(node, exclude, plain) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE || (exclude && exclude.includes(node))) return '';
    const tag = node.localName;
    if (tag === 'br') return '\n';
    if (node.matches(MATH_SELECTOR)) {
      const math = mathOf(node);
      if (math) return math.isBlock ? `\n$$${math.tex}$$\n` : `$${math.tex}$`;
      if (tag === 'math') return node.textContent;
    }
    if (tag === 'img' || skip(node)) return '';
    if (tag === 'code' && !plain) {
      const code = node.textContent.replace(/\s+/g, ' ');
      return code.includes('`') ? wrap(code, '`` ', ' ``') : wrap(code, '`');
    }
    let text = '';
    for (const child of node.childNodes) text += inline(child, exclude, plain);
    if (BLOCK.has(tag)) return `\n${text}\n`;
    if (plain) return text;
    switch (tag) {
      case 'a': {
        const href = opts.links && linkTarget(node);
        return href && text.trim() ? wrap(text.replace(/\n/g, ' '), '[', `](${href})`) : text;
      }
      case 'strong':
      case 'b':
        return wrap(text, '**');
      case 'em':
      case 'i':
        return wrap(text, '*');
      case 'del':
      case 's':
        return wrap(text, '~~');
      default:
        return text;
    }
  }

  const seenImages = new Set();
  function imageOf(img) {
    if (!opts.images || skip(img) || img.closest(MATH_SELECTOR)) return '';
    if (img.isConnected && img.getClientRects().length === 0) return ''; // inside a hidden ancestor
    const candidates = [
      img.currentSrc, img.getAttribute('src'), img.dataset.src, img.dataset.lazySrc, img.dataset.original,
    ];
    const raw = candidates.find((s) => s && !s.startsWith('data:'));
    if (!raw) return '';
    let src;
    try {
      src = new URL(raw, document.baseURI).href;
    } catch {
      return '';
    }
    if (seenImages.has(src)) return '';
    if (img.complete && img.naturalWidth > 0 && img.naturalWidth < 3) return ''; // tracking pixels
    seenImages.add(src);
    const alt = oneLine(img.getAttribute('alt') || '').replace(/[[\]]/g, '');
    return `![${alt}](${escapeUrl(src)})`;
  }

  function listOf(el) {
    const ordered = el.localName === 'ol';
    let index = Number(el.getAttribute('start')) || 1;
    const lines = [];
    for (const li of el.children) {
      if (li.localName !== 'li' || skip(li)) continue;
      const sublists = [...li.children].filter((c) => (c.localName === 'ul' || c.localName === 'ol') && !skip(c));
      const text = clean(inline(li, sublists));
      if (!text && !sublists.length) continue;
      const marker = ordered ? `${index++}.` : '-';
      const indent = ' '.repeat(marker.length + 1);
      const [first = '', ...rest] = text.split('\n');
      lines.push(`${marker} ${first}`.trimEnd(), ...rest.map((line) => indent + line));
      for (const sub of sublists) {
        const nested = listOf(sub);
        if (nested) lines.push(...nested.split('\n').map((line) => indent + line));
      }
    }
    return lines.join('\n');
  }

  function tableOf(table) {
    let header = null;
    const rows = [];
    for (const tr of table.rows) {
      if (skip(tr)) continue;
      const cells = [...tr.cells].filter((cell) => !skip(cell));
      const values = cells.map((cell) => oneLine(inline(cell)).replace(/\|/g, '\\|'));
      if (!values.some(Boolean)) continue;
      const isHeader = tr.parentElement.localName === 'thead' || cells.every((cell) => cell.localName === 'th');
      if (isHeader && !header && !rows.length) header = values;
      else rows.push(values);
    }
    // A header with no visible rows is usually a collapsed box: nothing worth keeping.
    if (!rows.length) return '';
    if (!header) header = rows.shift();
    const width = Math.max(header.length, ...rows.map((row) => row.length));
    const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] || '').join(' | ')} |`;
    const caption = table.caption ? oneLine(inline(table.caption)) : '';
    return [
      caption && `${wrap(caption, '**')}\n`,
      line(header),
      `| ${Array(width).fill('---').join(' | ')} |`,
      ...rows.map(line),
    ].filter(Boolean).join('\n');
  }

  const isLayoutTable = (table) => table.getAttribute('role') === 'presentation'
    || (!!table.querySelector('table') && !table.querySelector('th'));

  function definitionsOf(dl) {
    const items = [];
    for (const node of dl.querySelectorAll(':scope > dt, :scope > dd, :scope > div > dt, :scope > div > dd')) {
      if (skip(node)) continue;
      const text = oneLine(inline(node));
      if (!text) continue;
      if (node.localName === 'dt') items.push({ term: text, definitions: [] });
      else if (items.length) items[items.length - 1].definitions.push(text);
      else items.push({ term: '', definitions: [text] });
    }
    return items
      .map(({ term, definitions }) => `- ${[term && wrap(term, '**'), definitions.join(' ; ')].filter(Boolean).join(' : ')}`)
      .join('\n');
  }

  function block(el, out) {
    const tag = el.localName;
    const math = el.matches(MATH_SELECTOR) && mathOf(el);
    if (math) {
      out.push(`$$${math.tex}$$`);
    } else if (/^h[1-6]$/.test(tag)) {
      const text = oneLine(inline(el, null, true));
      if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
    } else if (tag === 'ul' || tag === 'ol') {
      const list = listOf(el);
      if (list) out.push(list);
    } else if (tag === 'table' && !isLayoutTable(el)) {
      const table = tableOf(el);
      if (table) out.push(table);
    } else if (tag === 'dl' && el.querySelector('dt')) {
      const definitions = definitionsOf(el);
      if (definitions) out.push(definitions);
    } else if (tag === 'blockquote') {
      const inner = [];
      walk(el, inner);
      const text = inner.join('\n\n');
      if (text) out.push(text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n'));
    } else if (tag === 'pre') {
      const text = el.textContent.replace(/^\n+|\s+$/g, '');
      if (text) {
        const language = /(?:lang|language)-([\w+#-]+)/.exec(
          `${el.getAttribute('class') || ''} ${el.querySelector('code')?.getAttribute('class') || ''}`
        );
        const fence = text.includes('```') ? '````' : '```';
        out.push(`${fence}${language ? language[1] : ''}\n${text}\n${fence}`);
      }
    } else if (tag === 'figure' && el.querySelector('img')) {
      const figcaption = el.querySelector('figcaption');
      const caption = figcaption ? oneLine(inline(figcaption)) : '';
      let added = false;
      for (const img of el.querySelectorAll('img')) {
        const image = imageOf(img);
        if (image) {
          out.push(image);
          added = true;
        }
      }
      if (caption) out.push(added ? wrap(caption, '*') : caption);
    } else if (tag !== 'hr') {
      walk(el, out);
    }
  }

  // Consecutive inline content (text, links, emphasis…) becomes one paragraph; block children recurse.
  function walk(el, out) {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const text = clean(run.map((node) => inline(node)).join(''));
      if (text) out.push(text);
      if (opts.images) {
        for (const node of run) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const imgs = node.localName === 'img' ? [node] : node.querySelectorAll('img');
          for (const img of imgs) {
            const image = imageOf(img);
            if (image) out.push(image);
          }
        }
      }
      run = [];
    };
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || skip(child)) continue;
      if (INLINE.has(child.localName) && !child.querySelector(BLOCK_SELECTOR)) {
        run.push(child);
        continue;
      }
      flush();
      block(child, out);
    }
    flush();
  }

  const chunks = [];
  walk(root, chunks);

  // The page title often sits just above the detected article container.
  if (opts.scope === 'main' && root !== document.body && !root.querySelector('h1')) {
    const h1 = document.querySelector('h1');
    if (h1 && !isHidden(h1) && h1.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const text = oneLine(inline(h1, null, true));
      if (text) chunks.unshift(`# ${text}`);
    }
  }

  const body = chunks.join('\n\n');
  if (!body) return { error: opts.scope === 'main' ? 'emptyMain' : 'empty' };

  // YAML front matter: JSON strings are valid YAML double-quoted scalars.
  function frontMatter() {
    const content = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim();
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    const fields = {
      title: document.title.trim(),
      url: location.href,
      canonical: canonical !== location.href ? canonical : undefined,
      site: content('meta[property="og:site_name"]'),
      description: content('meta[name="description"]') || content('meta[property="og:description"]'),
      author: content('meta[name="author"]'),
      published: content('meta[property="article:published_time"]'),
      modified: content('meta[property="article:modified_time"]'),
      lang: document.documentElement.lang,
      extracted: new Date().toISOString(),
    };
    const lines = Object.entries(fields).filter(([, value]) => value).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
    return `---\n${lines.join('\n')}\n---`;
  }

  const markdown = `${opts.meta ? `${frontMatter()}\n\n` : ''}${body}\n`;
  const readable = body.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  const words = (readable.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;

  return { markdown, title: document.title.trim(), url: location.href, words, root: describe(root) };
}
