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
