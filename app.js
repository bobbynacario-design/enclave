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
  registerAppURLGetter
} from './src/util/shell-bridge.js';

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
registerSidebarSyncer(function() { syncSidebarSelection(); });
registerURLSyncer(function()     { syncURLState(); });
registerPageLoader(function(p, params) { loadPage(p, params); });
registerAppURLGetter(function()  { return getAppURL(); });

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

// ─── Auth: sign in / sign out ────────────────────────────────────────────────
var runSignOut = function(accessDenied) {
  authFlowState.busy = true;
  state.accessDenied = !!accessDenied;
  state.user = null;
  state.isAdmin = false;
  state.circles = [];
  adminState.allowlist = [];
  if (feedState.unsubscribe) {
    feedState.unsubscribe();
    feedState.unsubscribe = null;
  }
  if (projectsState.unsubscribe) {
    projectsState.unsubscribe();
    projectsState.unsubscribe = null;
  }
  if (projectsState.sidebarUnsubscribe) {
    projectsState.sidebarUnsubscribe();
    projectsState.sidebarUnsubscribe = null;
  }
  resetProjectDetailState();
  resetMessagesState();
  resetResourcesState();
  resetShellRealtime();

  return signOut(auth).catch(function(err) {
    logError('Sign-out error', err);
  }).finally(function() {
    authFlowState.busy = false;
  });
};

var handleSignIn = function() {
  if (authFlowState.busy) return;
  state.accessDenied = false;
  authFlowState.busy = true;
  signInWithPopup(auth, googleProvider).then(function(result) {
    var credential = GAP.credentialFromResult(result);
    if (credential && credential.accessToken) {
      state.googleAccessToken = credential.accessToken;
    }
  }).catch(function(err) {
    logError('Sign-in error', err);
  }).finally(function() {
    authFlowState.busy = false;
  });
};

var handleSignOut = function() {
  if (authFlowState.busy) return;
  runSignOut(false);
};

// ─── Auth: allowlist check ───────────────────────────────────────────────────
var checkAllowlist = function(user) {
  if (!user.email) {
    runSignOut(true);
    return;
  }

  var emailKey = user.email.toLowerCase();
  var ref      = doc(db, 'allowlist', emailKey);

  getDoc(ref).then(function(snap) {
    if (snap.exists()) {
      state.user = user;
      upsertUserDoc(user, snap.data() || {}).then(function() {
        applyURLState();
        renderShell();
      }).catch(function(err) {
        logError('User bootstrap failed', err);
        applyURLState();
        renderShell();
      });
    } else {
      runSignOut(true);
    }
  }).catch(function(err) {
    logError('Allowlist check failed', err);
    runSignOut(true);
  });
};

// ─── User doc upsert (runs on every sign-in) ─────────────────────────────────
var upsertUserDoc = function(user, allowlistEntry) {
  var ref = doc(db, 'users', user.uid);
  var displayName = user.displayName || user.email;
  var allowedCircles = normalizeCircles(allowlistEntry && allowlistEntry.circles);
  return getDoc(ref).then(function(snap) {
    var base = {
      uid:      user.uid,
      email:    user.email,
      name:     displayName,
      initials: getInitials(displayName),
      photoURL: user.photoURL || '',
      lastSeen: serverTimestamp()
    };

    if (snap.exists()) {
      var existing = snap.data() || {};
      state.isAdmin = existing.role === 'admin';
      state.circles = state.isAdmin
        ? normalizeCircles(existing.circles)
        : allowedCircles.slice();

      var updatePayload = Object.assign({}, base);
      if (!state.isAdmin) {
        updatePayload.circles = allowedCircles.slice();
      }

      return updateDoc(ref, updatePayload).catch(function(err) {
        logError('User doc update failed', err);
      });
    } else {
      state.circles = allowedCircles.slice();
      base.joinedAt = serverTimestamp();
      base.bio      = '';
      base.role     = '';
      base.circles  = allowedCircles.slice();
      return setDoc(ref, base).catch(function(err) {
        logError('User doc create failed', err);
      });
    }
  });
};

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

// Cache-buster for HTML fragment fetches — bumped per release to defeat
// browser/CDN caching of components and pages.
var ASSET_VERSION = 'v107';

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

var syncResponsivePanels = function() {
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

var applyURLState = function() {
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

var syncURLState = function() {
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

var getAppURL = function() {
  var url = new URL(window.location.href);
  url.search = '';
  url.hash = '';

  if (/\/index\.html$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/index\.html$/i, '');
  }

  return url.toString();
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

// ─── Page loader ─────────────────────────────────────────────────────────────
var loadPage = function(page) {
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
    if (page === 'feed')    initFeedPage();
    if (page === 'members') initMembersPage();
    if (page === 'events')  initEventsPage();
    if (page === 'admin')   initAdminPage();
    if (page === 'messages') initMessagesPage();
    if (page === 'projects') initProjectsPage();
    if (page === 'resources') initResourcesPage();
    if (page === 'briefings') initBriefingsPage();
    if (page === 'notifications') initNotificationsPage();
  }).catch(function(err) {
    logError('Failed to load page ' + page, err);
    slot.innerHTML = '<div class="card"><p class="text-muted">Failed to load ' + page + '.</p></div>';
  });
};

// ─── Admin: init ──────────────────────────────────────────────────────────────
var initAdminPage = function() {
  if (!state.isAdmin) {
    renderAdminAccessDenied();
    return;
  }

  var checks = document.getElementById('adminInviteCircles');
  if (checks) {
    checks.innerHTML = renderCircleChecks([]);
  }

  var inviteBtn = document.getElementById('adminInviteBtn');
  if (inviteBtn) inviteBtn.addEventListener('click', handleAdminInvite);

  loadAllowlistMembers();
};

var renderAdminAccessDenied = function() {
  var list = document.querySelector('[data-slot="page"]');
  if (!list) return;

  list.innerHTML =
    '<div class="page-header">' +
      '<h1>Admin</h1>' +
      '<p class="text-muted">Manage invites and circle access.</p>' +
    '</div>' +
    '<div class="card">' +
      '<h2 class="profile-name">Admin access required</h2>' +
      '<p class="text-muted">This signed-in account is not loading as an admin.</p>' +
      '<p class="text-muted mt-16">Signed in as: ' + escapeHTML((state.user && state.user.email) || 'Unknown account') + '</p>' +
      '<div class="edit-actions">' +
        '<button class="btn btn-primary" id="adminBackToFeedBtn">Back to Feed</button>' +
      '</div>' +
    '</div>';

  var backBtn = document.getElementById('adminBackToFeedBtn');
  if (backBtn) {
    backBtn.addEventListener('click', function() {
      loadPage('feed');
    });
  }
};

// ─── Admin: load allowlist ────────────────────────────────────────────────────
var loadAllowlistMembers = function() {
  var list = document.getElementById('adminMembersList');
  if (!list) return;

  getDocs(collection(db, 'allowlist')).then(function(snap) {
    var entries = [];

    snap.forEach(function(d) {
      var data = d.data() || {};
      entries.push({
        email:   (data.email || d.id || '').toLowerCase(),
        circles: normalizeCircles(data.circles)
      });
    });

    entries.sort(function(a, b) {
      return a.email.localeCompare(b.email);
    });

    adminState.allowlist = entries;
    renderAllowlistMembers();
  }).catch(function(err) {
    logError('Failed to load allowlist', err);
    list.innerHTML = '<div class="card"><p class="text-muted">Failed to load allowlist. Check Firestore rules.</p></div>';
  });
};

// ─── Admin: render allowlist ──────────────────────────────────────────────────
var renderAllowlistMembers = function() {
  var list = document.getElementById('adminMembersList');
  if (!list) return;

  if (adminState.allowlist.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No invited emails yet.</p></div>';
    return;
  }

  list.innerHTML = adminState.allowlist.map(function(entry) {
    var circleTags = entry.circles.map(function(circleId) {
      return '<span class="circle-tag">' + escapeHTML(circleLabel(circleId)) + '</span>';
    }).join('');

    if (!circleTags) {
      circleTags = '<span class="circle-tag circle-tag-empty">No circles assigned</span>';
    }

    return '' +
      '<div class="card admin-member-row">' +
        '<div class="admin-member-meta">' +
          '<div class="admin-member-email">' + escapeHTML(entry.email) + '</div>' +
          '<div class="member-circles">' + circleTags + '</div>' +
        '</div>' +
        '<button class="btn btn-ghost admin-remove-btn" data-remove-email="' + escapeAttr(entry.email) + '">Remove</button>' +
      '</div>';
  }).join('');

  list.querySelectorAll('[data-remove-email]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleAdminRemove(btn.dataset.removeEmail);
    });
  });
};

// ─── Admin: invite / remove actions ───────────────────────────────────────────
var handleAdminInvite = function() {
  if (!state.isAdmin || !state.user) return;

  var emailEl = document.getElementById('adminInviteEmail');
  var saveBtn = document.getElementById('adminInviteBtn');
  if (!emailEl || !saveBtn) return;

  var email = emailEl.value.trim().toLowerCase();
  var circles = getCheckedCircles('#adminInviteCircles');

  if (!email) {
    showToast('Email is required.', 'error');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Enter a valid email address.', 'error');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  var ref = doc(db, 'allowlist', email);
  var existing = adminState.allowlist.find(function(entry) {
    return entry.email === email;
  });

  var payload = {
    email:     email,
    circles:   circles,
    invitedBy: state.user.uid,
    updatedAt: serverTimestamp()
  };

  if (!existing) {
    payload.createdAt = serverTimestamp();
  }

  setDoc(ref, payload, { merge: true }).then(function() {
    return syncUserDocsForAllowlist(email, circles);
  }).then(function() {
    return queueInviteEmail(email, circles);
  }).then(function() {
    emailEl.value = '';
    setCheckedCircles('#adminInviteCircles', []);
    showToast('Invite saved and email queued.', 'success');
    return loadAllowlistMembers();
  }).catch(function(err) {
    logError('Failed to save allowlist entry', err);
    showToast('Failed to save invite or queue the email. Check console for details.', 'error');
  }).finally(function() {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Invite';
  });
};

var handleAdminRemove = function(email) {
  if (!state.isAdmin || !email) return;

  showConfirmModal('Remove invite', 'Remove ' + email + ' from the allowlist?', 'Remove').then(function(confirmed) {
    if (!confirmed) return;

    deleteDoc(doc(db, 'allowlist', email)).then(function() {
      return syncUserDocsForAllowlist(email, []);
    }).then(function() {
      adminState.allowlist = adminState.allowlist.filter(function(entry) {
        return entry.email !== email;
      });
      renderAllowlistMembers();
      showToast('Invite removed.', 'success');
    }).catch(function(err) {
      logError('Failed to remove allowlist entry', err);
      showToast('Failed to remove invite. Check console for details.', 'error');
    });
  });
};

var syncUserDocsForAllowlist = function(email, circles) {
  var normalized = normalizeCircles(circles);
  var usersQuery = query(collection(db, 'users'), where('email', '==', email));

  return getDocs(usersQuery).then(function(snap) {
    var updates = [];

    snap.forEach(function(userSnap) {
      var userData = userSnap.data() || {};
      if (userData.role === 'admin') return;

      updates.push(updateDoc(doc(db, 'users', userSnap.id), {
        circles: normalized.slice()
      }));

      if (state.user && state.user.uid === userSnap.id) {
        state.circles = normalized.slice();
        document.querySelectorAll('.sidebar-link[data-circle]').forEach(function(btn) {
          btn.hidden = getVisibleCircles(state).indexOf(btn.dataset.circle) === -1;
        });
        syncSidebarSelection();
        loadPanelCircles();
      }

      var member = membersState.members.find(function(item) {
        return item.uid === userSnap.id;
      });
      if (member) {
        member.circles = normalized.slice();
      }
    });

    return Promise.all(updates);
  });
};

var queueInviteEmail = function(email, circles) {
  var inviteURL = getAppURL();
  var inviterName = (state.user && (state.user.displayName || state.user.email)) || 'Enclave Admin';
  var circleNames = normalizeCircles(circles).map(circleLabel);
  var circleLine = circleNames.length > 0
    ? circleNames.join(', ')
    : 'No circles assigned yet';
  var htmlList = circleNames.length > 0
    ? '<ul>' + circleNames.map(function(name) {
      return '<li>' + escapeHTML(name) + '</li>';
    }).join('') + '</ul>'
    : '<p>No circles assigned yet.</p>';

  return addDoc(collection(db, 'mail'), {
    to: [email],
    createdAt: serverTimestamp(),
    metadata: {
      type: 'invite',
      invitedEmail: email,
      invitedBy: state.user ? state.user.uid : '',
      circles: normalizeCircles(circles)
    },
    message: {
      subject: 'You are invited to Enclave',
      text:
        'You have been invited to Enclave by ' + inviterName + '.\n\n' +
        'Assigned circles: ' + circleLine + '\n\n' +
        'Open Enclave here:\n' + inviteURL + '\n\n' +
        'Sign in with this same Google account: ' + email + '\n',
      html:
        '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">' +
          '<h2>You are invited to Enclave</h2>' +
          '<p><strong>' + escapeHTML(inviterName) + '</strong> invited you to join Enclave.</p>' +
          '<p><strong>Assigned circles:</strong></p>' +
          htmlList +
          '<p><a href="' + escapeAttr(inviteURL) + '">Open Enclave</a></p>' +
          '<p>Sign in with this same Google account: <strong>' + escapeHTML(email) + '</strong></p>' +
        '</div>'
    }
  });
};


// ─── Helpers ─────────────────────────────────────────────────────────────────
var setCheckedCircles = function(containerSelector, circles) {
  var normalized = normalizeCircles(circles);

  document.querySelectorAll(containerSelector + ' input[type="checkbox"]').forEach(function(cb) {
    cb.checked = normalized.indexOf(cb.value) !== -1;
  });
};

var syncSidebarSelection = function() {
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
