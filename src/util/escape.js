export const escapeHTML = function(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
};

export const escapeAttr = function(str) {
  return String(str == null ? '' : str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
};

export const URL_REGEX = /https?:\/\/[^\s<>"'`,;)}\]]+/gi;

export const linkifyText = function(escapedHtml) {
  return escapedHtml.replace(URL_REGEX, function(url) {
    const clean = url.replace(/[.,;:!?)]+$/, '');
    const safeUrl = escapeAttr(clean);
    return '<a href="' + safeUrl + '" class="post-link" target="_blank" rel="noopener">' + clean + '</a>';
  });
};

export const highlightMentions = function(html) {
  return html.replace(/@(\w[\w\s]{0,30}\w)/g, '<span class="mention">@$1</span>');
};

export const extractFirstUrl = function(text) {
  const match = (text || '').match(URL_REGEX);
  if (!match) return '';
  return match[0].replace(/[.,;:!?)]+$/, '');
};

const RICH_TEXT_ALLOWED_TAGS = {
  a: true,
  b: true,
  blockquote: true,
  br: true,
  code: true,
  div: true,
  em: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  hr: true,
  i: true,
  li: true,
  ol: true,
  p: true,
  pre: true,
  s: true,
  span: true,
  strong: true,
  u: true,
  ul: true
};

const RICH_TEXT_DROP_CONTENT_TAGS = {
  embed: true,
  iframe: true,
  link: true,
  math: true,
  meta: true,
  object: true,
  script: true,
  style: true,
  svg: true,
  template: true
};

const isSafeRichTextUrl = function(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;

  try {
    const base = window.location && window.location.origin
      ? window.location.origin
      : 'https://enclave.local';
    const url = new URL(raw, base);
    return ['http:', 'https:', 'mailto:'].indexOf(url.protocol) !== -1;
  } catch (err) {
    return false;
  }
};

const sanitizeRichNode = function(node) {
  if (node.nodeType === Node.TEXT_NODE) return;

  if (node.nodeType !== Node.ELEMENT_NODE) {
    node.remove();
    return;
  }

  const tag = node.tagName.toLowerCase();

  if (!RICH_TEXT_ALLOWED_TAGS[tag]) {
    if (RICH_TEXT_DROP_CONTENT_TAGS[tag]) {
      node.remove();
      return;
    }

    const parent = node.parentNode;
    const children = Array.from(node.childNodes);
    while (node.firstChild) {
      parent.insertBefore(node.firstChild, node);
    }
    node.remove();
    children.forEach(sanitizeRichNode);
    return;
  }

  const href = tag === 'a' ? node.getAttribute('href') : '';
  const title = tag === 'a' ? node.getAttribute('title') : '';

  Array.from(node.attributes).forEach(function(attr) {
    node.removeAttribute(attr.name);
  });

  if (tag === 'a') {
    if (isSafeRichTextUrl(href)) {
      node.setAttribute('href', href.trim());
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('class', 'post-link');
      if (title) {
        node.setAttribute('title', title.slice(0, 120));
      }
    } else {
      const parent = node.parentNode;
      const children = Array.from(node.childNodes);
      while (node.firstChild) {
        parent.insertBefore(node.firstChild, node);
      }
      node.remove();
      children.forEach(sanitizeRichNode);
      return;
    }
  }

  Array.from(node.childNodes).forEach(sanitizeRichNode);
};

export const sanitizeRichHTML = function(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html == null ? '' : html);
  Array.from(template.content.childNodes).forEach(sanitizeRichNode);
  return template.innerHTML;
};

const appendRichTextWithLinks = function(parent, text) {
  const raw = String(text == null ? '' : text);
  let index = 0;
  let match;
  URL_REGEX.lastIndex = 0;

  while ((match = URL_REGEX.exec(raw)) !== null) {
    const url = match[0];
    const clean = url.replace(/[.,;:!?)]+$/, '');
    const trailing = url.slice(clean.length);

    if (match.index > index) {
      parent.appendChild(document.createTextNode(raw.slice(index, match.index)));
    }

    if (isSafeRichTextUrl(clean)) {
      const link = document.createElement('a');
      link.href = clean;
      link.className = 'post-link';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = clean;
      parent.appendChild(link);
    } else {
      parent.appendChild(document.createTextNode(clean));
    }

    if (trailing) {
      parent.appendChild(document.createTextNode(trailing));
    }

    index = match.index + url.length;
  }

  if (index < raw.length) {
    parent.appendChild(document.createTextNode(raw.slice(index)));
  }
};

const linkifyRichTextNodes = function(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;

  while ((node = walker.nextNode())) {
    if (node.parentElement && node.parentElement.closest('a')) continue;
    if (URL_REGEX.test(node.nodeValue || '')) {
      textNodes.push(node);
    }
    URL_REGEX.lastIndex = 0;
  }

  textNodes.forEach(function(textNode) {
    const frag = document.createDocumentFragment();
    appendRichTextWithLinks(frag, textNode.nodeValue || '');
    textNode.parentNode.replaceChild(frag, textNode);
  });
};

const highlightRichMentions = function(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;

  while ((node = walker.nextNode())) {
    if (/@(\w[\w\s]{0,30}\w)/.test(node.nodeValue || '')) {
      textNodes.push(node);
    }
  }

  textNodes.forEach(function(textNode) {
    const frag = document.createDocumentFragment();
    const raw = textNode.nodeValue || '';
    let index = 0;
    raw.replace(/@(\w[\w\s]{0,30}\w)/g, function(match, _name, offset) {
      if (offset > index) {
        frag.appendChild(document.createTextNode(raw.slice(index, offset)));
      }
      const mention = document.createElement('span');
      mention.className = 'mention';
      mention.textContent = match;
      frag.appendChild(mention);
      index = offset + match.length;
      return match;
    });
    if (index < raw.length) {
      frag.appendChild(document.createTextNode(raw.slice(index)));
    }
    textNode.parentNode.replaceChild(frag, textNode);
  });
};

export const renderRichText = function(html) {
  const template = document.createElement('template');
  template.innerHTML = sanitizeRichHTML(html);
  linkifyRichTextNodes(template.content);
  highlightRichMentions(template.content);
  return template.innerHTML;
};
