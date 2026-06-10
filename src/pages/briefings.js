// Firebase
import {
  doc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  deleteDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteField,
  serverTimestamp
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
import { showConfirmModal, openBriefingImportModal, openBriefingDiscussModal } from '../ui/modals.js';

const BRIEFING_READ_KEY = 'enclave_last_briefing_ts';

export const resetBriefingsState = function() {
  if (briefingsState.unsubscribe) {
    briefingsState.unsubscribe();
    briefingsState.unsubscribe = null;
  }
  Object.keys(briefingsState.reactionUnsubs).forEach(function(bid) {
    briefingsState.reactionUnsubs[bid]();
  });
  briefingsState.reactionUnsubs = {};
  briefingsState.reactions = {};
  briefingsState.briefings = [];
};

// Normalize sections: accept array [{id, stories}] or object {global: [...]}
const normalizeSections = function(b) {
  if (Array.isArray(b.sections)) return b.sections;
  const sectionList = [];
  if (b.sections && typeof b.sections === 'object') {
    Object.keys(b.sections).forEach(function(key) {
      sectionList.push({ id: key, stories: b.sections[key] });
    });
  }
  return sectionList;
};

// ─── Per-story reactions ─────────────────────────────────────────────────────
// Stored as briefings/{bid}/reactions/{uid} = { stories: { 'global_0': true } }
// where the key is '<sectionId>_<raw story index>'.

const getReactionState = function(bid) {
  return briefingsState.reactions[bid] || { counts: {}, mine: {} };
};

const updateReactionButtons = function(bid) {
  const rs = getReactionState(bid);
  document.querySelectorAll('[data-briefing-react="' + bid + '"]').forEach(function(btn) {
    const key = btn.getAttribute('data-story-key');
    const count = rs.counts[key] || 0;
    const countEl = btn.querySelector('.briefing-story-action-count');
    if (countEl) countEl.textContent = count > 0 ? String(count) : '';
    btn.classList.toggle('active', !!rs.mine[key]);
  });
};

const syncReactionSubscriptions = function() {
  const liveIds = {};
  briefingsState.briefings.forEach(function(b) { liveIds[b.id] = true; });

  Object.keys(briefingsState.reactionUnsubs).forEach(function(bid) {
    if (liveIds[bid]) return;
    briefingsState.reactionUnsubs[bid]();
    delete briefingsState.reactionUnsubs[bid];
    delete briefingsState.reactions[bid];
  });

  briefingsState.briefings.forEach(function(b) {
    if (briefingsState.reactionUnsubs[b.id]) return;
    briefingsState.reactionUnsubs[b.id] = onSnapshot(
      collection(db, 'briefings', b.id, 'reactions'),
      function(snap) {
        const counts = {};
        const mine = {};
        snap.forEach(function(d) {
          const stories = (d.data() || {}).stories || {};
          Object.keys(stories).forEach(function(key) {
            if (stories[key] !== true) return;
            counts[key] = (counts[key] || 0) + 1;
            if (state.user && d.id === state.user.uid) mine[key] = true;
          });
        });
        briefingsState.reactions[b.id] = { counts: counts, mine: mine };
        updateReactionButtons(b.id);
      },
      function(err) {
        logError('Briefing reactions subscribe error', err);
      }
    );
  });
};

const toggleStoryReact = function(bid, key) {
  if (!state.user) return;
  const ref = doc(db, 'briefings', bid, 'reactions', state.user.uid);
  let op;
  if (getReactionState(bid).mine[key]) {
    const patch = { updatedAt: serverTimestamp() };
    patch['stories.' + key] = deleteField();
    op = updateDoc(ref, patch);
  } else {
    const storiesPatch = {};
    storiesPatch[key] = true;
    op = setDoc(ref, { stories: storiesPatch, updatedAt: serverTimestamp() }, { merge: true });
  }
  op.catch(function(err) {
    logError('Briefing react failed', err);
    showToast('Could not save reaction. Try again.', 'error');
  });
};

const findBriefingStory = function(bid, key) {
  const briefing = briefingsState.briefings.find(function(b) { return b.id === bid; });
  if (!briefing) return null;
  const sep = key.lastIndexOf('_');
  const secId = key.slice(0, sep);
  const idx = parseInt(key.slice(sep + 1), 10);
  const sec = normalizeSections(briefing).find(function(s) { return s.id === secId; });
  const story = sec && Array.isArray(sec.stories) ? sec.stories[idx] : null;
  return story ? { briefing: briefing, story: story } : null;
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

  const sectionList = normalizeSections(b);
  const reactionState = getReactionState(b.id);

  let sections = '';
  sectionList.forEach(function(sec) {
    const stories = sec.stories || [];
    // If stories have a 'relevant' boolean field, filter by it; otherwise show all.
    // Reaction keys use the raw index so they stay stable regardless of filtering.
    const hasRelevantField = stories.length > 0 && typeof stories[0].relevant === 'boolean';
    const relevant = [];
    stories.forEach(function(s, idx) {
      if (hasRelevantField && s.relevant !== true) return;
      relevant.push({ story: s, key: sec.id + '_' + idx });
    });
    if (!relevant.length) return;
    const meta = BRIEFING_SECTION_META[sec.id] || { label: sec.id, color: '#888' };
    const storiesHtml = relevant.map(function(it) {
      const s = it.story;
      const count = reactionState.counts[it.key] || 0;
      const activeClass = reactionState.mine[it.key] ? ' active' : '';
      return '<div class="briefing-story" style="border-left-color:' + meta.color + '">' +
        '<div class="briefing-story-head">' + escapeHTML(s.headline) + '</div>' +
        '<div class="briefing-story-body">' + escapeHTML(s.body) + '</div>' +
        '<div class="briefing-story-actions">' +
          '<button class="briefing-story-action briefing-react-btn' + activeClass + '" data-briefing-react="' + escapeAttr(b.id) + '" data-story-key="' + escapeAttr(it.key) + '" aria-label="Like story">' +
            '&#128077; <span class="briefing-story-action-count">' + (count > 0 ? count : '') + '</span>' +
          '</button>' +
          '<button class="briefing-story-action" data-briefing-discuss="' + escapeAttr(b.id) + '" data-story-key="' + escapeAttr(it.key) + '" aria-label="Discuss story in the feed">' +
            '&#128172; Discuss' +
          '</button>' +
        '</div>' +
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
        // Reactions live in a subcollection and would be orphaned by the
        // doc delete, so clear them first.
        getDocs(collection(db, 'briefings', bid, 'reactions')).then(function(snap) {
          return Promise.all(snap.docs.map(function(d) { return deleteDoc(d.ref); }));
        }).then(function() {
          return deleteDoc(doc(db, 'briefings', bid));
        }).then(function() {
          showToast('Briefing deleted.', 'success');
        }).catch(function(err) {
          showToast('Delete failed: ' + err.message, 'error');
        });
      });
    });
  });

  listEl.querySelectorAll('[data-briefing-react]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      toggleStoryReact(btn.getAttribute('data-briefing-react'), btn.getAttribute('data-story-key'));
    });
  });

  listEl.querySelectorAll('[data-briefing-discuss]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const found = findBriefingStory(btn.getAttribute('data-briefing-discuss'), btn.getAttribute('data-story-key'));
      if (found) openBriefingDiscussModal(found.briefing, found.story);
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
    syncReactionSubscriptions();
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
