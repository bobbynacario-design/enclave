// Firebase
import {
  doc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  deleteDoc
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, briefingsState } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr } from '../util/escape.js';
import { BRIEFING_SECTION_META } from '../util/constants.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { showConfirmModal, openBriefingImportModal } from '../ui/modals.js';

const BRIEFING_READ_KEY = 'enclave_last_briefing_ts';

export const resetBriefingsState = function() {
  if (briefingsState.unsubscribe) {
    briefingsState.unsubscribe();
    briefingsState.unsubscribe = null;
  }
  briefingsState.briefings = [];
};

const getBriefingPublishedMs = function(b) {
  if (b.publishedAt && typeof b.publishedAt.toMillis === 'function') return b.publishedAt.toMillis();
  if (b.publishedAt && b.publishedAt.seconds) return b.publishedAt.seconds * 1000;
  return 0;
};

const syncBriefingBadge = function() {
  const dot = document.getElementById('briefingUnreadDot');
  if (dot) dot.style.display = briefingsState.hasUnread ? 'inline-block' : 'none';
  const headerBadge = document.getElementById('briefingNewBadge');
  if (headerBadge) headerBadge.style.display = briefingsState.hasUnread ? 'inline-block' : 'none';
};

export const subscribeBriefingNotifier = function() {
  if (briefingsState.unsubscribeNotifier) briefingsState.unsubscribeNotifier();

  const q = query(collection(db, 'briefings'), orderBy('publishedAt', 'desc'), limit(1));
  briefingsState.unsubscribeNotifier = onSnapshot(q, function(snap) {
    if (snap.empty) {
      briefingsState.hasUnread = false;
      syncBriefingBadge();
      return;
    }
    const latest = snap.docs[0].data();
    const latestMs = getBriefingPublishedMs(latest);
    const lastRead = parseInt(localStorage.getItem(BRIEFING_READ_KEY) || '0', 10);
    briefingsState.hasUnread = latestMs > lastRead;
    syncBriefingBadge();
  }, function(err) {
    logError('Briefing notifier error', err);
  });
};

const renderBriefingCard = function(b) {
  const m = b.markets || {};
  const pseiMove = String(m.psei_move || '');
  const asxMove = String(m.asx_move || '');
  const spMove = String(m.sp500_move || '');

  const tickerClass = function(move) {
    if (move.indexOf('up') === 0) return 'up';
    if (move.indexOf('down') === 0) return 'dn';
    return '';
  };

  const tickers =
    '<div class="briefing-tickers">' +
      '<div class="briefing-ticker">' +
        '<div class="briefing-ticker-label">PSEi</div>' +
        '<div class="briefing-ticker-value">' + escapeHTML(m.psei || '—') + '</div>' +
        '<div class="briefing-ticker-move ' + tickerClass(pseiMove) + '">' + escapeHTML(pseiMove || '—') + '</div>' +
      '</div>' +
      '<div class="briefing-ticker">' +
        '<div class="briefing-ticker-label">ASX 200</div>' +
        '<div class="briefing-ticker-value">' + escapeHTML(m.asx || '—') + '</div>' +
        '<div class="briefing-ticker-move ' + tickerClass(asxMove) + '">' + escapeHTML(asxMove || '—') + '</div>' +
      '</div>' +
      '<div class="briefing-ticker">' +
        '<div class="briefing-ticker-label">S&amp;P 500</div>' +
        '<div class="briefing-ticker-value">' + escapeHTML(m.sp500 || '—') + '</div>' +
        '<div class="briefing-ticker-move ' + tickerClass(spMove) + '">' + escapeHTML(spMove || '—') + '</div>' +
      '</div>' +
    '</div>';

  // Normalize sections: accept array [{id, stories}] or object {global: [...]}
  let sectionList = [];
  if (Array.isArray(b.sections)) {
    sectionList = b.sections;
  } else if (b.sections && typeof b.sections === 'object') {
    Object.keys(b.sections).forEach(function(key) {
      sectionList.push({ id: key, stories: b.sections[key] });
    });
  }

  let sections = '';
  sectionList.forEach(function(sec) {
    const stories = sec.stories || [];
    // If stories have a 'relevant' boolean field, filter by it; otherwise show all
    const hasRelevantField = stories.length > 0 && typeof stories[0].relevant === 'boolean';
    const relevant = hasRelevantField ? stories.filter(function(s) { return s.relevant === true; }) : stories;
    if (!relevant.length) return;
    const meta = BRIEFING_SECTION_META[sec.id] || { label: sec.id, color: '#888' };
    const storiesHtml = relevant.map(function(s) {
      return '<div class="briefing-story" style="border-left-color:' + meta.color + '">' +
        '<div class="briefing-story-head">' + escapeHTML(s.headline) + '</div>' +
        '<div class="briefing-story-body">' + escapeHTML(s.body) + '</div>' +
      '</div>';
    }).join('');
    sections +=
      '<div class="briefing-section">' +
        '<div class="briefing-section-label">' +
          '<span class="briefing-section-dot" style="background:' + meta.color + '"></span>' +
          escapeHTML(meta.label) +
        '</div>' +
        storiesHtml +
      '</div>';
  });

  let watchBox = '';
  if (b.watch) {
    watchBox =
      '<div class="briefing-watch">' +
        '<div class="briefing-watch-label">Watch</div>' +
        '<div class="briefing-watch-body">' + escapeHTML(b.watch) + '</div>' +
        (b.watch_source ? '<div class="briefing-watch-source">' + escapeHTML(b.watch_source) + '</div>' : '') +
      '</div>';
  }

  let adminBtn = '';
  if (state.isAdmin) {
    adminBtn = '<button class="btn btn-ghost" style="margin-left:auto;font-size:11px;color:var(--red)" data-briefing-delete="' + escapeAttr(b.id) + '">Delete</button>';
  }

  return '<div class="briefing-card">' +
    '<div class="briefing-card-head">' +
      '<div class="briefing-card-title">' + escapeHTML(b.date || 'Untitled') + '</div>' +
      '<div class="briefing-card-sub">Work Network · Daily Briefing</div>' +
    '</div>' +
    tickers +
    (sections ? '<div class="briefing-sections">' + sections + '</div>' : '') +
    watchBox +
    '<div class="briefing-footer">' +
      '<span class="briefing-footer-tag">' + escapeHTML(b.circle || 'work-network') + '</span>' +
      '<span class="briefing-footer-tag">Daily Briefing</span>' +
      '<span class="briefing-footer-tag">' + escapeHTML(b.date || '') + '</span>' +
      adminBtn +
    '</div>' +
  '</div>';
};

const renderBriefingList = function() {
  const listEl = document.getElementById('briefingList');
  if (!listEl) return;

  if (!briefingsState.briefings.length) {
    listEl.innerHTML = '<p class="text-muted">No briefings yet.</p>';
    return;
  }

  const sorted = briefingsState.briefings.slice().sort(function(a, b) {
    const da = new Date((a.date || '').replace(/^\w+,\s*/, ''));
    const db2 = new Date((b.date || '').replace(/^\w+,\s*/, ''));
    return (db2.getTime() || 0) - (da.getTime() || 0);
  });
  listEl.innerHTML = sorted.map(renderBriefingCard).join('');

  listEl.querySelectorAll('[data-briefing-delete]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const bid = btn.getAttribute('data-briefing-delete');
      showConfirmModal('Delete briefing', 'Delete this briefing?', 'Delete').then(function(confirmed) {
        if (!confirmed) return;
        deleteDoc(doc(db, 'briefings', bid)).then(function() {
          showToast('Briefing deleted.', 'success');
        }).catch(function(err) {
          showToast('Delete failed: ' + err.message, 'error');
        });
      });
    });
  });
};

const subscribeBriefings = function() {
  if (briefingsState.unsubscribe) briefingsState.unsubscribe();

  const q = query(collection(db, 'briefings'), orderBy('publishedAt', 'desc'), limit(10));
  briefingsState.unsubscribe = onSnapshot(q, function(snap) {
    briefingsState.briefings = snap.docs.map(function(d) {
      const data = d.data();
      data.id = d.id;
      return data;
    });
    renderBriefingList();
    markBriefingsRead();
  }, function(err) {
    logError('Briefings subscribe error', err);
    const listEl = document.getElementById('briefingList');
    if (listEl) listEl.innerHTML = '<p class="text-muted">Failed to load briefings.</p>';
  });
};

const markBriefingsRead = function() {
  const latest = briefingsState.briefings[0];
  if (!latest) return;
  // Find the newest publishedAt among all loaded briefings
  let maxMs = 0;
  briefingsState.briefings.forEach(function(b) {
    const ms = getBriefingPublishedMs(b);
    if (ms > maxMs) maxMs = ms;
  });
  if (maxMs > 0) {
    localStorage.setItem(BRIEFING_READ_KEY, String(maxMs));
    briefingsState.hasUnread = false;
    syncBriefingBadge();
  }
};

export const initBriefingsPage = function() {
  const adminBar = document.getElementById('briefingAdminBar');
  if (adminBar && state.isAdmin) adminBar.hidden = false;

  const importBtn = document.getElementById('briefingImportBtn');
  if (importBtn) importBtn.addEventListener('click', openBriefingImportModal);

  subscribeBriefings();
};
