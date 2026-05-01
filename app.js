// app.js — Enclave entry point

import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider as GAP
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  getDocs,
  serverTimestamp,
  Timestamp,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { auth, db, googleProvider } from './firebase.js';

import {
  escapeHTML,
  escapeAttr,
  linkifyText,
  highlightMentions,
  extractFirstUrl
} from './src/util/escape.js';

import {
  ALL_CIRCLES,
  ASSET_VERSION,
  FEED_PAGE_SIZE,
  STRATEGY_APP_URL,
  VALID_PAGES
} from './src/util/constants.js';

import {
  normalizeCircles,
  getVisibleCircles,
  getInitials,
  circleLabel,
  renderCircleOptions,
  renderCircleChecks,
  getCheckedCircles
} from './src/util/circles.js';

import { relativeTime, getFirestoreTimeMs } from './src/util/time.js';

import { logError } from './src/util/log.js';

import { showToast } from './src/ui/toast.js';

import {
  showConfirmModal,
  showNoticeModal
} from './src/ui/modals.js';

import {
  openDrivePicker,
  clearDriveAttachment,
  registerPickerHandler
} from './src/ui/drivePicker.js';

// Pages
import {
  initBriefingsPage,
  resetBriefingsState,
  subscribeBriefingNotifier
} from './src/pages/briefings.js';

import { initResourcesPage } from './src/pages/resources.js';

import {
  initEventsPage,
  loadPanelEvents
} from './src/pages/events.js';

import {
  initNotificationsPage,
  registerNotificationNavigator,
  subscribeNotifications
} from './src/pages/notifications.js';

import {
  initMembersPage,
  registerRecentPostsLoader,
  registerCirclesChangedHandler
} from './src/pages/members.js';

import {
  registerSidebarSyncer,
  registerURLSyncer,
  registerPageLoader,
  registerAppURLGetter,
  registerPanelCirclesLoader,
  registerShellRenderer,
  registerURLApplier
} from './src/util/shell-bridge.js';

import { initAdminPage } from './src/pages/admin.js';

import {
  handleSignIn,
  handleSignOut,
  checkAllowlist
} from './src/auth/auth.js';

import {
  loadPage,
  applyURLState,
  syncURLState,
  getAppURL,
  syncSidebarSelection,
  syncResponsivePanels
} from './src/shell/routing.js';

import {
  initProjectsPage,
  loadSidebarProjects
} from './src/pages/projects.js';

import {
  initFeedPage,
  loadProfileRecentPosts
} from './src/pages/feed.js';

import {
  initMessagesPage,
  subscribeConversations
} from './src/pages/messages.js';

import {
  state,
  authFlowState,
  feedState,
  membersState,
  adminState,
  messagesState,
  driveAttachment,
  shellState,
  projectsState,
  pickerState,
  resetMessagesState,
  resetShellRealtime,
  resetProjectDetailState,
  resetResourcesState
} from './src/state.js';

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
    var qs = Object.keys(params).map(function(k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    var url = '?page=' + page + (qs ? '&' + qs : '');
    window.history.replaceState(null, '', url);

    if (page === 'projects' && params.projectId) {
      projectsState.activeProjectId = params.projectId;
    }
    loadPage(page);
  }
});

// ─── Render: loading screen ──────────────────────────────────────────────────
var renderLoading = function(msg) {
  var app = document.getElementById('app');
  app.innerHTML = '<div id="loading">' + (msg || 'Loading...') + '</div>';
};

// ─── Render: login screen ────────────────────────────────────────────────────
var renderLogin = function() {
  var app = document.getElementById('app');

  var deniedHTML = state.accessDenied
    ? '<div class="login-error">Access restricted. You need an invite.</div>'
    : '';

  app.innerHTML =
    '<div class="login-wrap">' +
      '<div class="login-card">' +
        '<div class="login-logo">' +
          '<svg width="80" height="80" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
            '<polygon points="50,5 90,27.5 90,72.5 50,95 10,72.5 10,27.5" fill="#1A362B" stroke="#F4F1EA" stroke-width="3"/>' +
            '<path d="M50,5 L50,50 L90,72.5" fill="none" stroke="#F4F1EA" stroke-width="3"/>' +
            '<path d="M50,50 L10,72.5" fill="none" stroke="#F4F1EA" stroke-width="3"/>' +
            '<path d="M42,38 L60,38 M42,50 L56,50 M42,62 L60,62 M42,38 L42,62" fill="none" stroke="#F4F1EA" stroke-width="4" stroke-linecap="round"/>' +
          '</svg>' +
          '<div class="login-logo-text">ENCLAVE</div>' +
        '</div>' +
        '<div class="login-tagline">private &middot; invite-only</div>' +
        '<div class="login-desc">A private workspace for business interruption consulting and network management.</div>' +
        deniedHTML +
        '<button id="googleSignInBtn" class="btn-google">' +
          '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">' +
            '<path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>' +
            '<path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>' +
            '<path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>' +
            '<path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>' +
          '</svg>' +
          '<span>Sign in with Google</span>' +
        '</button>' +
        '<a class="login-privacy" href="privacy.html">Privacy Policy</a>' +
      '</div>' +
    '</div>';

  document.getElementById('googleSignInBtn').addEventListener('click', handleSignIn);
};


// ─── Render: app shell (logged in) ───────────────────────────────────────────
var renderShell = function() {
  var appEl = document.getElementById('app');

  fetch('components/shell.html?' + ASSET_VERSION).then(function(res) {
    if (!res.ok) throw new Error('shell HTTP ' + res.status);
    return res.text();
  }).then(function(shellHTML) {
    appEl.innerHTML = shellHTML;

    // Nav links
    document.querySelectorAll('[data-page="admin"]').forEach(function(btn) {
      btn.hidden = !state.isAdmin;
    });

    document.querySelectorAll('[data-page]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        window.enclaveGoPage(btn.dataset.page);
      });
    });

    document.querySelectorAll('.sidebar-link[data-circle]').forEach(function(btn) {
      btn.hidden = getVisibleCircles(state).indexOf(btn.dataset.circle) === -1;
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        window.enclaveGoCircle(btn.dataset.circle);
      });
    });

    // Theme toggle (both sidebar and mobile)
    var syncThemeBtns = function() {
      var isLight = document.body.classList.contains('light');
      var icon = isLight ? '☀️' : '🌙';
      document.querySelectorAll('.theme-toggle').forEach(function(btn) {
        btn.textContent = icon;
      });
    };
    syncThemeBtns();
    document.querySelectorAll('.theme-toggle').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var isLight = document.body.classList.toggle('light');
        localStorage.setItem('enclave_theme', isLight ? 'light' : 'dark');
        syncThemeBtns();
      });
    });

    // Sign out
    var signOutBtn = document.querySelector('[data-action="sign-out"]');
    if (signOutBtn) signOutBtn.addEventListener('click', handleSignOut);

    // Mobile "More" menu toggle
    var moreBtn = document.getElementById('mobileMoreBtn');
    var moreMenu = document.getElementById('mobileMoreMenu');
    if (moreBtn && moreMenu) {
      moreBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        moreMenu.classList.toggle('open');
      });
      moreMenu.addEventListener('click', function(e) {
        e.stopPropagation();
      });
    }

    // User profile row
    if (state.user) {
      var nameEl  = document.querySelector('[data-slot="user-name"]');
      var emailEl = document.querySelector('[data-slot="user-email"]');
      var avEl    = document.querySelector('[data-slot="user-avatar"]');
      if (nameEl)  nameEl.textContent  = state.user.displayName || 'Member';
      if (emailEl) emailEl.textContent = state.user.email || '';
      if (avEl && state.user.photoURL) {
        avEl.style.backgroundImage = 'url(' + escapeAttr(state.user.photoURL) + ')';
      }
    }

    // Sidebar "new project" link
    var newProjLink = document.querySelector('[data-action="new-project"]');
    if (newProjLink) {
      newProjLink.addEventListener('click', function(e) {
        e.preventDefault();
        projectsState.activeProjectId = null;
        projectsState.editingProjectId = null;
        projectsState.openModalOnLoad = true;
        loadPage('projects');
      });
    }

    syncSidebarSelection();
    subscribeConversations();
    subscribeBriefingNotifier();
    subscribeNotifications();
    loadOnlineUsers();
    startPresenceHeartbeat();
    loadPanelEvents();
    loadPanelCircles();
    loadSidebarProjects();
    syncResponsivePanels();
    loadPage(state.currentPage);
  }).catch(function(err) {
    logError('Failed to load shell', err);
    appEl.innerHTML = '<div id="loading">Failed to load shell.</div>';
  });
};

var getOnlineUsersThreshold = function() {
  return Timestamp.fromDate(new Date(Date.now() - 5 * 60000));
};

var updatePresenceHeartbeat = function() {
  if (!state.user) return;

  updateDoc(doc(db, 'users', state.user.uid), {
    lastSeen: serverTimestamp()
  }).catch(function(err) {
    logError('Failed to update presence heartbeat', err);
  });
};

var startPresenceHeartbeat = function() {
  if (!state.user) return;

  if (shellState.presenceTimer) {
    window.clearInterval(shellState.presenceTimer);
  }

  updatePresenceHeartbeat();
  shellState.presenceTimer = window.setInterval(updatePresenceHeartbeat, 60000);
};

var loadOnlineUsers = function() {
  var el = document.getElementById('panelOnline');
  if (!el) return;

  if (shellState.unsubscribeOnline) {
    shellState.unsubscribeOnline();
    shellState.unsubscribeOnline = null;
  }

  var q = query(
    collection(db, 'users'),
    where('lastSeen', '>=', getOnlineUsersThreshold()),
    orderBy('lastSeen', 'desc'),
    limit(8)
  );

  shellState.unsubscribeOnline = onSnapshot(q, function(snap) {
    var users = [];

    snap.forEach(function(d) {
      var data = d.data() || {};
      data.uid = d.id;
      users.push(data);
    });

    users = users.filter(function(user) {
      return user.uid !== (state.user && state.user.uid);
    });

    if (users.length === 0) {
      el.className = 'panel-empty';
      el.textContent = 'No one else online right now.';
      return;
    }

    el.className = 'panel-online-list';
    el.innerHTML = users.map(function(user) {
      var initials = escapeHTML(getInitials(user.name || user.email || '?'));
      var name = escapeHTML(user.name || user.email || 'Member');
      var meta = escapeHTML(user.role || user.email || '');
      var avatarStyle = user.photoURL
        ? ' style="background-image:url(' + escapeAttr(user.photoURL) + ')"'
        : '';
      var avatarText = user.photoURL ? '' : initials;

      return '' +
        '<div class="panel-online-user">' +
          '<div class="panel-online-avatar"' + avatarStyle + '>' + avatarText + '</div>' +
          '<div class="panel-online-meta">' +
            '<div class="panel-online-name">' + name + '</div>' +
            '<div class="panel-online-subtitle">' + meta + '</div>' +
          '</div>' +
          '<div class="panel-online-dot"></div>' +
        '</div>';
    }).join('');
  }, function(err) {
    logError('Failed to load online users', err);
    el.className = 'panel-empty';
    el.textContent = 'Failed to load online users.';
  });
};


var loadPanelCircles = function() {
  var el = document.getElementById('panelCircles');
  if (!el) return;

  var circles = state.isAdmin
    ? ALL_CIRCLES.slice()
    : normalizeCircles(state.circles);

  if (circles.length === 0) {
    el.className = 'panel-empty';
    el.textContent = 'Not in any circles yet.';
    return;
  }

  el.className = 'panel-circles';
  el.innerHTML = circles.map(function(circleId) {
    return '' +
      '<button type="button" class="panel-circle-btn" data-panel-circle="' + escapeAttr(circleId) + '">' +
        '<span class="panel-circle-title">' + escapeHTML(circleLabel(circleId)) + '</span>' +
        '<span class="panel-circle-subtitle">Open feed</span>' +
      '</button>';
  }).join('');

  el.querySelectorAll('[data-panel-circle]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      window.enclaveGoCircle(btn.dataset.panelCircle);
    });
  });
};

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

window.addEventListener('resize', function() {
  syncResponsivePanels();
});

// Close mobile More menu on outside tap (registered once, not per renderShell)
document.addEventListener('click', function() {
  var m = document.getElementById('mobileMoreMenu');
  if (m) m.classList.remove('open');
});
