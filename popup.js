const STORAGE_KEY = 'page-to-md:options';
const LANG_KEY = 'page-to-md:lang';
const BUNDLE_KEY = 'bundle';
const DEFAULTS = { scope: 'main', meta: true, links: true, images: true };
const PREVIEW_LIMIT = 200000;

const STRINGS = {
  en: {
    scopeLabel: 'Area',
    scopeMain: 'Main content',
    scopePage: 'Whole page',
    scopeSelection: 'Selection',
    includeLabel: 'Include',
    meta: 'Metadata',
    metaHint: 'YAML header: title, URL, description, author, dates',
    links: 'Links',
    images: 'Images',
    copy: 'Copy',
    copyAI: 'Copy for AI',
    copyAIHint: 'Wrapped in <document> tags with the source URL, ready to paste into an AI chat',
    download: 'Download .md',
    copied: 'Copied ✓',
    copyFailed: 'Copy failed',
    bundleTitle: 'Bundle',
    bundleAdd: '+ Add page',
    bundleCopy: 'Copy bundle',
    bundleClear: 'Clear',
    bundleEmpty: 'collect several pages for one AI prompt.',
    added: 'Added ✓',
    updated: 'Updated ✓',
    bundleSummary: (count, tokens) => `${count} ${count > 1 ? 'pages' : 'page'} · ≈ ${tokens} tokens`,
    extracting: 'Extracting…',
    selection: 'selection',
    truncated: '… (preview truncated)',
    noResult: 'the page returned no result',
    units: ['B', 'KB'],
    words: (n) => `${n} words`,
    area: (root) => `area: ${root}`,
    failed: (message) => `Extraction failed: ${message}`,
    errors: {
      noBody: 'This page has no readable HTML content.',
      noSelection: 'No text selected on the page.',
      emptyMain: 'No text found in the main content. Try “Whole page”.',
      empty: 'No text found.',
      fileAccess: 'To read a local file, turn on “Allow access to file URLs” in the extension details (chrome://extensions).',
      restricted: 'Chrome does not allow extensions on this page (chrome:// pages, Chrome Web Store, other extensions).',
    },
  },
  fr: {
    scopeLabel: 'Zone',
    scopeMain: 'Contenu principal',
    scopePage: 'Page entière',
    scopeSelection: 'Sélection',
    includeLabel: 'Inclure',
    meta: 'Métadonnées',
    metaHint: 'En-tête YAML : titre, URL, description, auteur, dates',
    links: 'Liens',
    images: 'Images',
    copy: 'Copier',
    copyAI: "Copier pour l'IA",
    copyAIHint: "Entouré de balises <document> avec l'URL source, prêt à coller dans une IA",
    download: 'Télécharger .md',
    copied: 'Copié ✓',
    copyFailed: 'Échec de la copie',
    bundleTitle: 'Lot de pages',
    bundleAdd: '+ Ajouter',
    bundleCopy: 'Copier le lot',
    bundleClear: 'Vider',
    bundleEmpty: 'collectez plusieurs pages pour une IA.',
    added: 'Ajoutée ✓',
    updated: 'Mise à jour ✓',
    bundleSummary: (count, tokens) => `${count} page${count > 1 ? 's' : ''} · ≈ ${tokens} tokens`,
    extracting: 'Extraction…',
    selection: 'sélection',
    truncated: '… (aperçu tronqué)',
    noResult: "la page n'a renvoyé aucun résultat",
    units: ['o', 'Ko'],
    words: (n) => `${n} mots`,
    area: (root) => `zone : ${root}`,
    failed: (message) => `Extraction impossible : ${message}`,
    errors: {
      noBody: "Cette page n'a pas de contenu HTML lisible.",
      noSelection: 'Aucun texte sélectionné sur la page.',
      emptyMain: 'Aucun texte trouvé dans le contenu principal. Essayer « Page entière ».',
      empty: 'Aucun texte trouvé.',
      fileAccess: "Pour lire un fichier local, activer « Autoriser l'accès aux URL de fichier » dans les détails de l'extension (chrome://extensions).",
      restricted: "Chrome n'autorise pas les extensions sur cette page (pages chrome://, Chrome Web Store, autres extensions).",
    },
  },
};

const form = document.getElementById('options');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const copyButton = document.getElementById('copy');
const copyAIButton = document.getElementById('copy-ai');
const downloadButton = document.getElementById('download');
const bundleSummary = document.getElementById('bundle-summary');
const bundleAddButton = document.getElementById('bundle-add');
const bundleCopyButton = document.getElementById('bundle-copy');
const bundleClearButton = document.getElementById('bundle-clear');
const langButtons = document.querySelectorAll('[data-lang]');

let lang = loadLanguage();
let t = STRINGS[lang];
let number = new Intl.NumberFormat(lang);
let markdown = '';
let fileName = 'page.md';
let runId = 0;
let current = null; // last successful extraction: { url, title, scope, markdown }
let bundle = [];

function loadLanguage() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved in STRINGS) return saved;
  } catch {
    // Storage unavailable: fall back to the browser language.
  }
  return navigator.language.startsWith('fr') ? 'fr' : 'en';
}

function applyLanguage() {
  t = STRINGS[lang];
  number = new Intl.NumberFormat(lang);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t[el.dataset.i18n];
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t[el.dataset.i18nTitle];
  for (const button of langButtons) button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
  renderBundle();
}

function loadOptions() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function readOptions() {
  const fields = form.elements;
  return {
    scope: fields.scope.value,
    meta: fields.meta.checked,
    links: fields.links.checked,
    images: fields.images.checked,
  };
}

function writeOptions(options) {
  const fields = form.elements;
  fields.scope.value = options.scope;
  fields.meta.checked = options.meta;
  fields.links.checked = options.links;
  fields.images.checked = options.images;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function showError(message) {
  markdown = '';
  current = null;
  outputEl.textContent = '';
  copyButton.disabled = copyAIButton.disabled = downloadButton.disabled = true;
  setStatus(message, true);
  renderBundle();
}

// Long documents wrapped the way Anthropic recommends for prompts; any LLM reads it well.
function forAI(pages) {
  const documents = pages.map((page, i) => [
    pages.length > 1 ? `<document index="${i + 1}">` : '<document>',
    `<source>${page.url}</source>`,
    '<document_content>',
    page.markdown.trim(),
    '</document_content>',
    '</document>',
  ].join('\n'));
  return pages.length > 1 ? `<documents>\n${documents.join('\n')}\n</documents>\n` : `${documents[0]}\n`;
}

function renderBundle() {
  const characters = bundle.reduce((sum, page) => sum + page.markdown.length, 0);
  bundleSummary.textContent = bundle.length
    ? t.bundleSummary(bundle.length, number.format(Math.round(characters / 4)))
    : t.bundleEmpty;
  bundleAddButton.disabled = !current;
  bundleCopyButton.disabled = bundleClearButton.disabled = !bundle.length;
}

async function loadBundle() {
  const stored = await chrome.storage.local.get(BUNDLE_KEY);
  bundle = stored[BUNDLE_KEY] || [];
  renderBundle();
}

function saveBundle() {
  renderBundle();
  return chrome.storage.local.set({ [BUNDLE_KEY]: bundle });
}

function explain(error, tab) {
  const message = String((error && error.message) || error);
  if (/cannot access|cannot be scripted|chrome:\/\/|chrome-extension:\/\/|extensions gallery/i.test(message)) {
    return tab && tab.url && tab.url.startsWith('file:') ? t.errors.fileAccess : t.errors.restricted;
  }
  return t.failed(message);
}

const slug = (text) => text
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'page';

const formatSize = (bytes) => (bytes < 1024
  ? `${bytes} ${t.units[0]}`
  : `${number.format(Math.round(bytes / 102.4) / 10)} ${t.units[1]}`);

function highlight(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/^---\n[\s\S]*?\n---(?=\n)/, (match) => `<span class="fm">${match}</span>`)
    .replace(/^#{1,6} .*$/gm, (match) => `<span class="h">${match}</span>`)
    .replace(/\]\(([^)\s]+)\)/g, '](<span class="url">$1</span>)');
}

function render(result, options) {
  markdown = result.markdown;
  current = { url: result.url, title: result.title, scope: options.scope, markdown };
  fileName = `${slug(result.title || new URL(result.url).hostname)}.md`;
  const preview = markdown.length > PREVIEW_LIMIT ? `${markdown.slice(0, PREVIEW_LIMIT)}\n${t.truncated}` : markdown;
  outputEl.innerHTML = highlight(preview);
  outputEl.scrollTop = 0;

  // Rough rule of thumb: about 4 characters per token.
  setStatus([
    t.words(number.format(result.words)),
    `≈ ${number.format(Math.round(markdown.length / 4))} tokens`,
    formatSize(new Blob([markdown]).size),
    t.area(options.scope === 'selection' ? t.selection : result.root),
  ].join(' · '));
  copyButton.disabled = copyAIButton.disabled = downloadButton.disabled = false;
  renderBundle();
}

async function extract() {
  const run = ++runId;
  const options = readOptions();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Storage unavailable: options simply won't be remembered.
  }
  setStatus(t.extracting);

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
      args: [options],
    });
    if (run !== runId) return;
    const result = injection && injection.result;
    if (!result) throw new Error(t.noResult);
    if (result.error) showError(t.errors[result.error] || result.error);
    else render(result, options);
  } catch (error) {
    if (run === runId) showError(explain(error, tab));
  }
}

function flash(button, label) {
  button.textContent = label;
  clearTimeout(button.flashTimer);
  button.flashTimer = setTimeout(() => {
    button.textContent = t[button.dataset.i18n];
  }, 1400);
}

async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, t.copied);
  } catch {
    flash(button, t.copyFailed);
  }
}

copyButton.addEventListener('click', () => copyText(copyButton, markdown));
copyAIButton.addEventListener('click', () => copyText(copyAIButton, forAI([current])));
bundleCopyButton.addEventListener('click', () => copyText(bundleCopyButton, forAI(bundle)));

bundleAddButton.addEventListener('click', async () => {
  // Re-adding a page replaces it; selections pile up since each one can be a different excerpt.
  const index = current.scope === 'selection'
    ? -1
    : bundle.findIndex((page) => page.url === current.url && page.scope === current.scope);
  if (index >= 0) bundle[index] = { ...current };
  else bundle.push({ ...current });
  await saveBundle();
  flash(bundleAddButton, index >= 0 ? t.updated : t.added);
});

bundleClearButton.addEventListener('click', async () => {
  bundle = [];
  await saveBundle();
});

downloadButton.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

for (const button of langButtons) {
  button.addEventListener('click', () => {
    if (button.dataset.lang === lang) return;
    lang = button.dataset.lang;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // Storage unavailable: the language resets next time.
    }
    applyLanguage();
    extract();
  });
}

form.addEventListener('change', extract);
form.addEventListener('submit', (event) => event.preventDefault());

applyLanguage();
writeOptions(loadOptions());
loadBundle();
extract();
