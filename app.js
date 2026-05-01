// app.js — Enclave entry point

import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

import { auth } from './firebase.js';

import { VALID_PAGES } from './src/util/constants.js';

import {
  registerRecentPostsLoader,
  registerCirclesChangedHandler
} from './src/pages/members.js';

import { registerNotificationNavigator } from './src/pages/notifications.js';

import {
  registerSidebarSyncer,
  registerURLSyncer,
  registerPageLoader,
  registerAppURLGetter,
  registerPanelCirclesLoader,
  registerShellRenderer,
  registerURLApplier
} from './src/util/shell-bridge.js';

import { checkAllowlist } from './src/auth/auth.js';

import {
  loadPage,
  applyURLState,
  syncURLState,
  getAppURL,
  syncSidebarSelection,
  syncResponsivePanels
} from './src/shell/routing.js';

import { loadProfileRecentPosts } from './src/pages/feed.js';

import {
  state,
  adminState,
  projectsState,
  resetMessagesState,
  resetShellRealtime
} from './src/state.js';

import {
  renderShell,
  renderLogin,
  renderLoading,
  loadPanelCircles
} from './src/shell/shell.js';

// ─── Shell-bridge registrations ───────────────────────────────────────────────
registerRecentPostsLoader(loadProfileRecentPosts);
registerCirclesChangedHandler(function() {
  loadPanelCircles();
  syncSidebarSelection();
});
registerSidebarSyncer(function()      { syncSidebarSelection(); });
registerURLSyncer(function()          { syncURLState(); });
registerPageLoader(function(p, params){ loadPage(p, params); });
registerAppURLGetter(function()       { return getAppURL(); });
registerPanelCirclesLoader(function() { loadPanelCircles(); });
registerShellRenderer(function()      { renderShell(); });
registerURLApplier(function()         { applyURLState(); });

registerNotificationNavigator(function(page, params) {
  if (page && VALID_PAGES[page]) {
    const qs = Object.keys(params).map(function(k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    const url = '?page=' + page + (qs ? '&' + qs : '');
    window.history.replaceState(null, '', url);

    if (page === 'projects' && params.projectId) {
      projectsState.activeProjectId = params.projectId;
    }
    loadPage(page);
  }
});

// ─── Auth state listener ──────────────────────────────────────────────────────
onAuthStateChanged(auth, function(user) {
  if (user) {
    renderLoading('Checking access...');
    checkAllowlist(user);
  } else {
    state.user = null;
    state.isAdmin = false;
    state.circles = [];
    adminState.allowlist = [];
    resetMessagesState();
    resetShellRealtime();
    renderLogin();
  }
});

// ─── Global event listeners ───────────────────────────────────────────────────
window.addEventListener('resize', function() {
  syncResponsivePanels();
});

// Close mobile More menu on outside tap (registered once, not per renderShell)
document.addEventListener('click', function() {
  const m = document.getElementById('mobileMoreMenu');
  if (m) m.classList.remove('open');
});
