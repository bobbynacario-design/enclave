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

// ─── Modal accessibility ──────────────────────────────────────────────────────
// Every dialog in the app is a plain div, so dialog semantics, Escape, the
// focus trap and focus restoration all have to be wired by hand. wireModalA11y
// covers both the dynamic dialogs below and the markup modals in pages/.
//
// Handlers live on a stack rather than one listener per modal: a confirm dialog
// can open on top of the profile modal, and Escape must close only the topmost.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const modalStack = [];
let keyHandlerBound = false;
let dialogTitleSeq = 0;

const handleModalKeydown = function(e) {
  if (!modalStack.length) return;
  if (e.key !== 'Escape' && e.key !== 'Tab') return;
  modalStack[modalStack.length - 1].handle(e);
};

export const wireModalA11y = function(opts) {
  const card = opts.card;
  if (!card) return function() {};

  const title   = opts.title || null;
  const onClose = opts.onClose || function() {};
  const opener  = document.activeElement;

  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  if (!card.hasAttribute('tabindex')) { card.tabIndex = -1; }

  if (title) {
    if (!title.id) { title.id = 'dialogTitle' + (++dialogTitleSeq); }
    card.setAttribute('aria-labelledby', title.id);
  } else if (opts.label) {
    card.setAttribute('aria-label', opts.label);
  }

  const focusables = function() {
    return Array.prototype.filter.call(
      card.querySelectorAll(FOCUSABLE_SELECTOR),
      function(el) { return el.getClientRects().length > 0; }
    );
  };

  const entry = {
    handle: function(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      const items = focusables();
      if (!items.length) {
        e.preventDefault();
        card.focus();
        return;
      }

      const first = items[0];
      const last  = items[items.length - 1];

      // Focus escaped the card — pull it back to the near edge.
      if (!card.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  modalStack.push(entry);

  if (!keyHandlerBound) {
    document.addEventListener('keydown', handleModalKeydown, true);
    keyHandlerBound = true;
  }

  const initial = opts.initialFocus || focusables()[0] || card;
  if (initial && typeof initial.focus === 'function') { initial.focus(); }

  let torn = false;

  return function teardown() {
    if (torn) return;
    torn = true;

    const idx = modalStack.indexOf(entry);
    if (idx !== -1) { modalStack.splice(idx, 1); }

    if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
      opener.focus();
    }
  };
};

// The dynamic dialogs below all reuse #dialogBackdrop, so opening one while
// another is up must tear the old one down or it strands its stack entry.
let activeDialogTeardown = null;

export const removeExistingDialog = function() {
  if (activeDialogTeardown) {
    activeDialogTeardown();
    activeDialogTeardown = null;
  }

  const existing = document.getElementById('dialogBackdrop');
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
};

// Wires a freshly built #dialogBackdrop dialog and remembers its teardown.
export const registerDialog = function(opts) {
  const inner = wireModalA11y(opts);

  const wrapped = function() {
    inner();
    if (activeDialogTeardown === wrapped) { activeDialogTeardown = null; }
  };

  activeDialogTeardown = wrapped;
  return wrapped;
};

export const showDialogModal = function(opts) {
  opts = opts || {};

  removeExistingDialog();

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

    let teardown = null;

    const close = function(result) {
      if (teardown) { teardown(); }
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

    teardown = registerDialog({
      card:         card,
      title:        title,
      initialFocus: confirmBtn,
      onClose:      function() { close(false); }
    });
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
  removeExistingDialog();

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
  label.htmlFor = 'briefingImportJSON';
  label.style.cssText = 'display:block;font-size:12px;font-weight:500;margin-bottom:6px;color:var(--text-muted)';

  const textarea = document.createElement('textarea');
  textarea.id = 'briefingImportJSON';
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

  let teardown = null;

  const close = function() {
    if (teardown) { teardown(); }
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

  teardown = registerDialog({
    card:         card,
    title:        title,
    initialFocus: textarea,
    onClose:      close
  });
};

// ─── Briefing discuss modal ───────────────────────────────────────────────────
// Quotes a briefing story headline and posts the member's take to the feed.
export const openBriefingDiscussModal = function(briefing, story) {
  removeExistingDialog();

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
  textarea.setAttribute('aria-label', 'Your take on this story');
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

  let teardown = null;

  const close = function() {
    if (teardown) { teardown(); }
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

  teardown = registerDialog({
    card:         card,
    title:        title,
    initialFocus: textarea,
    onClose:      close
  });
};

// ─── Circle picker modal ──────────────────────────────────────────────────────
export const showCirclePickerModal = function(opts) {
  opts = opts || {};

  removeExistingDialog();

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

    let teardown = null;

    const close = function(result) {
      if (teardown) { teardown(); }
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

    teardown = registerDialog({
      card:         card,
      title:        title,
      initialFocus: saveBtn,
      onClose:      function() { close(null); }
    });
  });
};
