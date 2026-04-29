import {
  addDoc,
  collection,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';
import { state } from '../state.js';
import { escapeHTML, escapeAttr } from '../util/escape.js';
import { logError } from '../util/log.js';
import { showToast } from './toast.js';

export const showDialogModal = function(opts) {
  opts = opts || {};

  const existing = document.getElementById('dialogBackdrop');
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }

  return new Promise(function(resolve) {
    const backdrop = document.createElement('div');
    const card = document.createElement('div');
    const title = document.createElement('div');
    const message = document.createElement('div');
    const actions = document.createElement('div');
    const cancelBtn = document.createElement('button');
    const confirmBtn = document.createElement('button');

    backdrop.id = 'dialogBackdrop';
    backdrop.className = 'dialog-backdrop';

    card.className = 'dialog-card';
    title.className = 'dialog-title';
    title.textContent = opts.title || 'Notice';
    message.className = 'dialog-message';
    message.textContent = opts.message || '';
    actions.className = 'dialog-actions';

    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';

    confirmBtn.type = 'button';
    confirmBtn.className = opts.tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    confirmBtn.textContent = opts.confirmLabel || 'OK';

    const close = function(result) {
      if (backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
      resolve(result);
    };

    if (!opts.hideCancel) {
      actions.appendChild(cancelBtn);
      cancelBtn.addEventListener('click', function() {
        close(false);
      });
    }

    actions.appendChild(confirmBtn);
    confirmBtn.addEventListener('click', function() {
      close(true);
    });

    backdrop.addEventListener('click', function(e) {
      if (e.target === backdrop) {
        close(false);
      }
    });

    card.appendChild(title);
    card.appendChild(message);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    confirmBtn.focus();
  });
};

export const showNoticeModal = function(title, message, confirmLabel) {
  return showDialogModal({
    title: title,
    message: message,
    confirmLabel: confirmLabel || 'OK',
    hideCancel: true
  });
};

export const showConfirmModal = function(title, message, confirmLabel) {
  return showDialogModal({
    title: title,
    message: message,
    confirmLabel: confirmLabel || 'Confirm',
    cancelLabel: 'Cancel',
    tone: 'danger'
  });
};

export const openBriefingImportModal = function() {
  const existing = document.getElementById('dialogBackdrop');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const backdrop = document.createElement('div');
  backdrop.id = 'dialogBackdrop';
  backdrop.className = 'dialog-backdrop';

  const card = document.createElement('div');
  card.className = 'dialog-card';

  const title = document.createElement('div');
  title.className = 'dialog-title';
  title.textContent = 'Import Briefing';

  const label = document.createElement('label');
  label.textContent = 'Paste Gemini JSON';
  label.style.cssText = 'display:block;font-size:12px;font-weight:500;margin-bottom:6px;color:var(--text-muted)';

  const textarea = document.createElement('textarea');
  textarea.rows = 12;
  textarea.style.cssText = 'width:100%;font-family:monospace;font-size:12px;background:var(--surface-2);color:var(--text);border:0.5px solid var(--border);border-radius:var(--radius);padding:10px;resize:vertical';

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancel';

  const publishBtn = document.createElement('button');
  publishBtn.type = 'button';
  publishBtn.className = 'btn btn-primary';
  publishBtn.textContent = 'Publish';

  const close = function() {
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  };

  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', function(e) {
    if (e.target === backdrop) close();
  });

  publishBtn.addEventListener('click', function() {
    const raw = textarea.value.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      showToast('Invalid JSON.', 'error');
      return;
    }

    if (!parsed.date || !parsed.markets || !parsed.sections) {
      showToast('Missing required fields: date, markets, sections.', 'error');
      return;
    }

    publishBtn.disabled = true;
    publishBtn.textContent = 'Publishing...';

    parsed.publishedAt  = serverTimestamp();
    parsed.publishedBy  = state.user.uid;
    parsed.circle       = 'work-network';

    addDoc(collection(db, 'briefings'), parsed).then(function() {
      close();
      showToast('Briefing published.', 'success');
    }).catch(function(err) {
      publishBtn.disabled = false;
      publishBtn.textContent = 'Publish';
      showToast('Publish failed: ' + err.message, 'error');
    });
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(publishBtn);
  card.appendChild(title);
  card.appendChild(label);
  card.appendChild(textarea);
  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  textarea.focus();
};
