// This module needs a DOM document, but no editor, window or component state.
const excluded = 'blockquote,style,script';
const tokenPattern = /\{\{([가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9_ ]{1,30})\}\}/g;
const urlPattern = /(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.|\/\/)[^\s<>]+/gi;
const builtins = ['받는사람이름', '오늘', '내이름', '내주소'];
function fragment(html) { const root = document.createElement('template'); root.innerHTML = html; return root; }
function tokens(text) {
  const urls = [...text.matchAll(urlPattern)].map(match => [match.index, match.index + match[0].length]);
  return [...text.matchAll(tokenPattern)].filter(match => !urls.some(([start, end]) => match.index >= start && match.index < end));
}
function replace(text, values) {
  let result = '', offset = 0;
  for (const match of tokens(text)) {
    result += text.slice(offset, match.index) + (!Object.hasOwn(values, match[1]) || values[match[1]] === undefined || values[match[1]] === '' ? match[0] : values[match[1]]);
    offset = match.index + match[0].length;
  }
  return result + text.slice(offset);
}
function textNodes(root) {
  const walker = document.createTreeWalker(root, 4), nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest(excluded)) nodes.push(node);
  return nodes;
}
function pathOf(node, root) {
  const path = [];
  while (node !== root) { path.unshift([...node.parentNode.childNodes].indexOf(node)); node = node.parentNode; }
  return path;
}
function atPath(root, path) { for (const index of path) { root = root?.childNodes[index]; } return root; }

// Recognition and pre-send warnings deliberately share exactly the same boundaries.
export function templateVariables({ subject = '', html = '' }) {
  const names = new Set(tokens(subject).map(match => match[1]));
  for (const node of textNodes(fragment(html).content)) for (const match of tokens(node.data)) names.add(match[1]);
  return [...names];
}
export const unfilledTemplateVariables = templateVariables;
export function templateDefaults({ to = [], from = '', identities = [], now = new Date() } = {}) {
  const sender = identities.find(item => item.address.toLowerCase() === from.toLowerCase());
  const first = to[0];
  return {
    받는사람이름: first?.name || first?.address?.split('@')[0] || '',
    오늘: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now),
    내이름: sender?.name || '', 내주소: sender?.address || from,
  };
}
export function fillTemplate({ subject = '', html = '' }, values) {
  const root = fragment(html);
  for (const node of textNodes(root.content)) node.data = replace(node.data, values);
  return { subject: replace(subject, values), html: root.innerHTML };
}

// Bindings retain source text only in live UI state. Never use it when saving mail.
export function createTemplateVariables(current, context) {
  const root = fragment(current.html), values = templateDefaults(context);
  const state = {
    names: templateVariables(current), values, manual: [],
    subject: { source: current.subject, expected: current.subject, detached: false },
    nodes: textNodes(root.content).filter(node => tokens(node.data).length).map(node => ({ path: pathOf(node, root.content), source: node.data, expected: node.data, detached: false })),
  };
  return updateTemplateVariables({ ...current, html: root.innerHTML }, state, {}, { manual: false });
}
export function updateTemplateVariables(current, previous, changes, { manual = true } = {}) {
  const state = structuredClone(previous), root = fragment(current.html);
  for (const name of state.names) if (Object.hasOwn(changes, name)) {
    state.values = { ...state.values, [name]: String(changes[name]) };
    if (manual && !state.manual.includes(name)) state.manual.push(name);
  }
  let subject = current.subject;
  if (subject !== state.subject.expected) state.subject.detached = true;
  if (!state.subject.detached) subject = replace(state.subject.source, state.values);
  state.subject.expected = subject;
  for (const binding of state.nodes) {
    const node = atPath(root.content, binding.path);
    if (node?.nodeType !== 3 || node.data !== binding.expected || node.parentElement?.closest(excluded)) binding.detached = true;
    if (!binding.detached) { node.data = replace(binding.source, state.values); binding.expected = node.data; }
  }
  return { subject, html: root.innerHTML, state };
}
export function refreshTemplateDefaults(current, state, context) {
  const defaults = templateDefaults(context), changes = {};
  if (Object.hasOwn(state.values, '오늘')) defaults.오늘 = state.values.오늘;
  for (const name of builtins) if (!state.manual.includes(name)) changes[name] = defaults[name];
  return updateTemplateVariables(current, state, changes, { manual: false });
}
// Dialog drafts are independent copies: close/reopen keeps the live state; cancel
// restores only variable content/state, leaving recipients and uploads alone.
export function beginTemplateVariableEdit(current, state) { return structuredClone({ subject: current.subject, html: current.html, state }); }
export function cancelTemplateVariableEdit(snapshot) { return structuredClone(snapshot); }

function protectedContent(root, nonce) {
  const protectedNodes = new Set(root.querySelectorAll('blockquote'));
  const walker = document.createTreeWalker(root, 128);
  const startText = nonce ? `webmail-signature:${nonce}` : 'webmail-signature';
  let start;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('blockquote')) continue;
    if (node.data === startText) start = node;
    else if (start && node.data === `/${startText}` && start.parentNode === node.parentNode) {
      for (let item = start; item; item = item.nextSibling) { protectedNodes.add(item); if (item === node) break; }
      start = null;
    }
  }
  return protectedNodes;
}
function authoredRoot(root, protectedNodes) {
  const copy = root.cloneNode(true), originals = [...root.childNodes], clones = [...copy.childNodes];
  // Walk corresponding child lists before deletion can shift their indexes.
  function removeProtected(original, clone) {
    if (protectedNodes.has(original)) { clone.remove(); return; }
    const children = [...clone.childNodes];
    [...original.childNodes].forEach((node, index) => removeProtected(node, children[index]));
  }
  originals.forEach((node, index) => removeProtected(node, clones[index]));
  return copy;
}
function keepProtected(root, protectedNodes) {
  function keep(node) {
    if (protectedNodes.has(node)) return true;
    let retained = false;
    for (const child of [...node.childNodes]) { if (keep(child)) retained = true; else child.remove(); }
    return retained;
  }
  for (const node of [...root.childNodes]) if (!keep(node)) node.remove();
}
function usesTemplateSubject(model, mode) {
  return model.kind === 'new' && (!model.subject || mode === 'replace') || model.kind === 'draft' && !model.subject;
}
export function insertTemplate(model, template, { mode, html = template.html, uploads = [] } = {}) {
  const root = fragment(model.html), protectedNodes = protectedContent(root.content, model.signatureNonce);
  const authored = authoredRoot(root.content, protectedNodes);
  const hasContent = Boolean(authored.textContent.trim() || authored.querySelector('img,hr,table'));
  if (!mode && hasContent) return { confirmationRequired: true, patch: null };
  if (mode && !['replace', 'append'].includes(mode)) throw new TypeError('Unknown template insertion mode');
  if (mode === 'replace' || !hasContent) keepProtected(root.content, protectedNodes);
  // Insert before the first signature or quote, including nested boundaries.
  const walker = document.createTreeWalker(root.content, 0xffffffff);
  let boundary;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (protectedNodes.has(node)) { boundary = node; break; }
  const content = fragment(html).content;
  if (boundary) boundary.before(content); else root.content.append(content);
  const subject = usesTemplateSubject(model, mode) ? template.subject : model.subject;
  // Caller reconciles the HTML through updateCompositionHtml to refresh signature
  // ranges/manifests. No sender, recipient or threading field is in this patch.
  return { confirmationRequired: false, patch: { html: root.innerHTML, subject, attachments: [...model.attachments, ...uploads] } };
}

// Save only authored content and uploads, never signature/quoted originals.
export function templateSaveInput(model, { name, existing } = {}) {
  const root = fragment(model.html), protectedNodes = protectedContent(root.content, model.signatureNonce);
  for (const node of root.content.querySelectorAll('.sig')) protectedNodes.add(node);
  const authored = authoredRoot(root.content, protectedNodes), container = document.createElement('div');
  container.append(authored);
  return { name, subject: model.subject, html: container.innerHTML, attachments: model.attachments.filter(file => file.id).map(file => ({ uploadId: file.id })), shared: existing?.inShared ?? false };
}

// Initialize only the newly inserted template. Existing authored text, signature
// and preserved reply/draft subjects must never be filled as a side effect.
export function composeTemplateInsertion(model, template, options, context) {
  const preflight = insertTemplate(model, template, options);
  if (preflight.confirmationRequired) return preflight;
  const subjectUsed = usesTemplateSubject(model, options.mode);
  const filled = createTemplateVariables({ subject: subjectUsed ? template.subject : '', html: options.html ?? template.html }, context);
  const marker = crypto.randomUUID(), wrapper = fragment('');
  const region = document.createElement('div'); region.className = 'tplA-tbody'; region.setAttribute('data-wm-template-region', marker);
  region.innerHTML = filled.html; wrapper.content.append(region);
  const result = insertTemplate(model, { ...template, subject: filled.subject }, { ...options, html: wrapper.innerHTML });
  const root = fragment(result.patch.html), inserted = root.content.querySelector(`[data-wm-template-region="${marker}"]`);
  const prefix = pathOf(inserted, root.content); inserted.removeAttribute('data-wm-template-region');
  for (const binding of filled.state.nodes) binding.path = [...prefix, ...binding.path];
  if (!subjectUsed) filled.state.subject = { source: model.subject, expected: model.subject, detached: true };
  return { confirmationRequired: false, patch: { ...result.patch, html: root.innerHTML, templateState: filled.state } };
}

export const isDefaultTemplateVariable = name => builtins.includes(name);
export function templateSendWarnings(current) {
  const title = new Set(templateVariables({ subject: current.subject }));
  const body = new Set(templateVariables({ html: current.html }));
  return unfilledTemplateVariables(current).map(name => ({ name, location: title.has(name) && body.has(name) ? '제목·본문' : title.has(name) ? '제목' : '본문' }));
}
// Add explicitly typed placeholders without restoring any already edited prose.
export function prepareTemplateVariables(current, previous, context) {
  if (!previous) return createTemplateVariables(current, context);
  const prepared = updateTemplateVariables(current, previous, {}, { manual: false });
  const state = prepared.state, root = fragment(prepared.html);
  state.names = [...new Set([...state.names, ...templateVariables(prepared)])];
  for (const node of textNodes(root.content)) {
    if (!tokens(node.data).length) continue;
    const path = pathOf(node, root.content);
    if (!state.nodes.some(binding => !binding.detached && JSON.stringify(binding.path) === JSON.stringify(path))) state.nodes.push({ path, source: node.data, expected: node.data, detached: false });
  }
  if (state.subject.detached && tokens(prepared.subject).length) state.subject = { source: prepared.subject, expected: prepared.subject, detached: false };
  return updateTemplateVariables(prepared, state, {}, { manual: false });
}

export function templateVariableValue(state, name) {
  return Object.hasOwn(state.values, name) ? state.values[name] : '';
}
