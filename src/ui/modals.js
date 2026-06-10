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
import { renderCircleChecks, getCheckedCircles, getInitials } from '../util/circles.js';

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

// ─── Briefing discuss modal ───────────────────────────────────────────────────
// Quotes a briefing story headline and posts the member's take to the feed.
export const openBriefingDiscussModal = function(briefing, story) {
  const existing = document.getElementById('dialogBackdrop');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const backdrop = document.createElement('div');
  backdrop.id = 'dialogBackdrop';
  backdrop.className = 'dialog-backdrop';

  const card = document.createElement('div');
  card.className = 'dialog-card';

  const title = document.createElement('div');
  title.className = 'dialog-title';
  title.textContent = 'Discuss in the feed';

  const quote = document.createElement('div');
  quote.textContent = story.headline || '';
  quote.style.cssText = 'font-size:13px;font-weight:500;line-height:1.4;background:var(--surface-2);border-left:2px solid var(--accent, #7F77DD);border-radius:var(--radius);padding:10px 12px;margin-bottom:10px';

  const textarea = document.createElement('textarea');
  textarea.rows = 4;
  textarea.placeholder = 'Share your take...';
  textarea.maxLength = 2000;
  textarea.style.cssText = 'width:100%;font-family:var(--sans);font-size:13px;background:var(--surface-2);color:var(--text);border:0.5px solid var(--border);border-radius:var(--radius);padding:10px;resize:vertical';

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'Cancel';

  const postBtn = document.createElement('button');
  postBtn.type = 'button';
  postBtn.className = 'btn btn-primary';
  postBtn.textContent = 'Post';

  const close = function() {
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  };

  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', function(e) {
    if (e.target === backdrop) close();
  });

  postBtn.addEventListener('click', function() {
    if (!state.user) return;
    const take = textarea.value.trim();
    if (!take) {
      showToast('Write something first.', 'error');
      return;
    }

    // Post into the briefing's circle when the member belongs to it;
    // otherwise fall back to 'all' so the post rules still allow it.
    const inCircle = state.isAdmin ||
      (Array.isArray(state.circles) && state.circles.indexOf(briefing.circle) !== -1);
    const circle = inCircle ? (briefing.circle || 'all') : 'all';
    const displayName = state.user.displayName || state.user.email;
    const headline = String(story.headline || '').trim();

    postBtn.disabled = true;
    postBtn.textContent = 'Posting...';

    addDoc(collection(db, 'posts'), {
      authorId:       state.user.uid,
      authorName:     displayName,
      authorInitials: getInitials(displayName),
      circle:         circle,
      body:           '📰 ' + headline + '\n\n' + take,
      timestamp:      serverTimestamp(),
      reacts:         [],
      comments:       []
    }).then(function() {
      close();
      showToast('Posted to the feed.', 'success');
    }).catch(function(err) {
      logError('Briefing discuss post failed', err);
      postBtn.disabled = false;
      postBtn.textContent = 'Post';
      showToast('Post failed: ' + err.message, 'error');
    });
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(postBtn);
  card.appendChild(title);
  card.appendChild(quote);
  card.appendChild(textarea);
  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  textarea.focus();
};

// ─── Circle picker modal ──────────────────────────────────────────────────────
export const showCirclePickerModal = function(opts) {
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
    const checksContainer = document.createElement('div');
    const actions = document.createElement('div');
    const cancelBtn = document.createElement('button');
    const saveBtn = document.createElement('button');

    backdrop.id = 'dialogBackdrop';
    backdrop.className = 'dialog-backdrop';

    card.className = 'dialog-card';

    title.className = 'dialog-title';
    title.textContent = opts.title || 'Select circles';

    message.className = 'dialog-message';
    message.textContent = opts.message || '';

    checksContainer.id = 'circlePickerChecks';
    checksContainer.className = 'circle-checks';
    checksContainer.innerHTML = renderCircleChecks(opts.initialCircles || []);

    actions.className = 'dialog-actions';

    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancel';

    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = opts.confirmLabel || 'Save';

    const close = function(result) {
      if (backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
      resolve(result);
    };

    cancelBtn.addEventListener('click', function() { close(null); });

    saveBtn.addEventListener('click', function() {
      close(getCheckedCircles('#circlePickerChecks'));
    });

    backdrop.addEventListener('click', function(e) {
      if (e.target === backdrop) { close(null); }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    card.appendChild(title);
    if (opts.message) { card.appendChild(message); }
    card.appendChild(checksContainer);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    saveBtn.focus();
  });
};
