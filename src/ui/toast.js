export const ensureToastRoot = function() {
  const root = document.getElementById('toastRoot');
  if (root) return root;

  const newRoot = document.createElement('div');
  newRoot.id = 'toastRoot';
  newRoot.className = 'toast-root';
  document.body.appendChild(newRoot);
  return newRoot;
};

export const showToast = function(message, tone, timeoutMs) {
  const root = ensureToastRoot();
  const toast = document.createElement('div');

  toast.className = 'toast toast-' + (tone || 'info');
  toast.textContent = String(message || '');
  root.appendChild(toast);

  requestAnimationFrame(function() {
    toast.classList.add('toast-visible');
  });

  const dismiss = function() {
    toast.classList.remove('toast-visible');
    window.setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 180);
  };

  toast.addEventListener('click', dismiss);
  window.setTimeout(dismiss, timeoutMs || 3200);
};
