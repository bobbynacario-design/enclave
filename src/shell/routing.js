// Routing module — page navigation, URL sync, sidebar selection

import {
  doc,
  getDoc
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { db } from '../../firebase.js';

import {
  state,
  feedState,
  projectsState,
  resetProjectDetailState,
  resetMessagesState,
  resetResourcesState
} from '../state.js';

import { ASSET_VERSION, VALID_PAGES } from '../util/constants.js';

import {
  normalizeCircles,
  getVisibleCircles
} from '../util/circles.js';

import { logError } from '../util/log.js';

import { loadPanelCircles } from '../util/shell-bridge.js';

import {
  initBriefingsPage,
  resetBriefingsState
} from '../pages/briefings.js';

import { initFeedPage }          from '../pages/feed.js';
import { initMembersPage }       from '../pages/members.js';
import { initEventsPage }        from '../pages/events.js';
import { initAdminPage }         from '../pages/admin.js';
import { initMessagesPage }      from '../pages/messages.js';
import { initProjectsPage }      from '../pages/projects.js';
import { initResourcesPage }     from '../pages/resources.js';
import { initNotificationsPage } from '../pages/notifications.js';

// ─── Global nav handlers (set at module load time) ────────────────────────────
window.enclaveGoPage = function(page) {
  if (page === 'admin' && state.user) {
    refreshCurrentUserState().then(function() {
      loadPage('admin');
    }).catch(function(err) {
      logError('Failed to refresh user state before admin nav', err);
      loadPage('admin');
    });
    return;
  }

  if (page === 'feed') {
    feedState.filter = 'all';
    feedState.targetPostId = '';
    feedState.pendingTargetScroll = false;
  }
  loadPage(page);
};

window.enclaveGoCircle = function(circle) {
  feedState.filter = circle;
  feedState.targetPostId = '';
  feedState.pendingTargetScroll = false;
  loadPage('feed');
};

var refreshCurrentUserState = function() {
  if (!state.user) return Promise.resolve();

  return getDoc(doc(db, 'users', state.user.uid)).then(function(snap) {
    if (!snap.exists()) return;

    var data = snap.data() || {};
    state.isAdmin = data.role === 'admin';
    state.circles = normalizeCircles(data.circles);

    document.querySelectorAll('[data-page="admin"]').forEach(function(btn) {
      btn.hidden = !state.isAdmin;
    });

    document.querySelectorAll('.sidebar-link[data-circle]').forEach(function(btn) {
      btn.hidden = getVisibleCircles(state).indexOf(btn.dataset.circle) === -1;
    });

    syncSidebarSelection();
    loadPanelCircles();
  });
};

// ─── Layout sync ──────────────────────────────────────────────────────────────
export var syncResponsivePanels = function() {
  var shell = document.querySelector('.shell');
  var rightRail = document.querySelector('.shell-right');
  if (shell) {
    shell.setAttribute('data-current-page', state.currentPage || 'feed');
  }
  if (!rightRail) return;

  var isCompactLayout = window.matchMedia('(max-width: 1100px)').matches;
  if (isCompactLayout) {
    rightRail.style.display = state.currentPage === 'feed' ? 'block' : 'none';
  } else {
    rightRail.style.display = '';
  }
};

// ─── URL state ────────────────────────────────────────────────────────────────
export var applyURLState = function() {
  var params = new URLSearchParams(window.location.search);
  var page = params.get('page');
  var circle = params.get('circle');
  var postId = params.get('postId');

  if (page && VALID_PAGES[page]) {
    state.currentPage = page;
  }

  if (state.currentPage === 'projects') {
    var projectId = params.get('projectId');
    if (projectId) {
      projectsState.activeProjectId = projectId;
    }
  }

  if (state.currentPage === 'feed') {
    feedState.targetPostId = postId || '';
    feedState.pendingTargetScroll = !!feedState.targetPostId;
    if (feedState.targetPostId) {
      feedState.openComments[feedState.targetPostId] = true;
    }

    if (circle && getVisibleCircles(state).indexOf(circle) !== -1) {
      feedState.filter = circle;
    } else {
      feedState.filter = 'all';
    }
  } else {
    feedState.targetPostId = '';
    feedState.pendingTargetScroll = false;
  }
};

export var syncURLState = function() {
  var params = new URLSearchParams(window.location.search);
  params.set('page', state.currentPage);

  if (state.currentPage === 'feed' && feedState.filter !== 'all') {
    params.set('circle', feedState.filter);
  } else {
    params.delete('circle');
  }

  if (state.currentPage === 'feed' && feedState.targetPostId) {
    params.set('postId', feedState.targetPostId);
  } else {
    params.delete('postId');
  }

  if (state.currentPage === 'projects' && projectsState.activeProjectId) {
    params.set('projectId', projectsState.activeProjectId);
  } else {
    params.delete('projectId');
  }

  var nextURL = window.location.pathname + '?' + params.toString();
  window.history.replaceState({}, '', nextURL);
};

export var getAppURL = function() {
  var url = new URL(window.location.href);
  url.search = '';
  url.hash = '';

  if (/\/index\.html$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/index\.html$/i, '');
  }

  return url.toString();
};

// ─── Page loader ──────────────────────────────────────────────────────────────
export var loadPage = function(page) {
  state.currentPage = page;
  syncURLState();
  syncResponsivePanels();

  // Clean up any previous page subscriptions
  if (feedState.unsubscribe) {
    feedState.unsubscribe();
    feedState.unsubscribe = null;
  }
  if (projectsState.unsubscribe) {
    projectsState.unsubscribe();
    projectsState.unsubscribe = null;
  }
  resetProjectDetailState();
  if (page !== 'projects') {
    projectsState.activeProjectId = null;
  }

  resetMessagesState(false);
  resetResourcesState();
  resetBriefingsState();

  var slot = document.querySelector('[data-slot="page"]');
  if (!slot) return;

  // Highlight active nav link
  syncSidebarSelection();

  fetch('pages/' + page + '.html?' + ASSET_VERSION).then(function(res) {
    if (!res.ok) throw new Error('page HTTP ' + res.status);
    return res.text();
  }).then(function(pageHTML) {
    slot.innerHTML = pageHTML;

    // Page-specific init
    if (page === 'feed')          initFeedPage();
    if (page === 'members')       initMembersPage();
    if (page === 'events')        initEventsPage();
    if (page === 'admin')         initAdminPage();
    if (page === 'messages')      initMessagesPage();
    if (page === 'projects')      initProjectsPage();
    if (page === 'resources')     initResourcesPage();
    if (page === 'briefings')     initBriefingsPage();
    if (page === 'notifications') initNotificationsPage();
  }).catch(function(err) {
    logError('Failed to load page ' + page, err);
    slot.innerHTML = '<div class="card"><p class="text-muted">Failed to load ' + page + '.</p></div>';
  });
};

// ─── Sidebar selection ────────────────────────────────────────────────────────
export var syncSidebarSelection = function() {
  document.querySelectorAll('.sidebar-link[data-page]').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.page === state.currentPage);
  });

  document.querySelectorAll('.mobile-nav-link[data-page]').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.page === state.currentPage);
  });

  // Highlight More button when a "more" page is active
  var morePages = { events: true, members: true, resources: true, admin: true, notifications: true };
  var moreBtn = document.getElementById('mobileMoreBtn');
  if (moreBtn) moreBtn.classList.toggle('active', !!morePages[state.currentPage]);

  document.querySelectorAll('.mobile-more-item[data-page]').forEach(function(item) {
    item.classList.toggle('active', item.dataset.page === state.currentPage);
  });

  document.querySelectorAll('.sidebar-link[data-circle]').forEach(function(btn) {
    var isActive = state.currentPage === 'feed' &&
      feedState.filter !== 'all' &&
      btn.dataset.circle === feedState.filter;

    btn.classList.toggle('active', isActive);
  });

  document.querySelectorAll('.sidebar-link[data-project]').forEach(function(btn) {
    btn.classList.toggle('active',
      state.currentPage === 'projects' &&
      projectsState.activeProjectId &&
      btn.dataset.project === projectsState.activeProjectId
    );
  });
};
