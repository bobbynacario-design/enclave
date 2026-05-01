// Shell render and presence module

import {
  doc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { db } from '../../firebase.js';

import { state, shellState, projectsState } from '../state.js';

import { escapeHTML, escapeAttr } from '../util/escape.js';

import {
  getInitials,
  circleLabel,
  getVisibleCircles,
  normalizeCircles
} from '../util/circles.js';

import { ALL_CIRCLES, ASSET_VERSION } from '../util/constants.js';

import { logError } from '../util/log.js';

import { handleSignIn, handleSignOut } from '../auth/auth.js';

import {
  loadPage,
  syncSidebarSelection,
  syncResponsivePanels
} from './routing.js';

import { subscribeConversations }   from '../pages/messages.js';
import { subscribeBriefingNotifier } from '../pages/briefings.js';
import { subscribeNotifications }    from '../pages/notifications.js';
import { loadPanelEvents }           from '../pages/events.js';
import { loadSidebarProjects }       from '../pages/projects.js';

// ─── PWA install prompt ───────────────────────────────────────────────────────
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  // Show install button if shell is already rendered
  const btn = document.getElementById('installEnclaveBtn');
  if (btn) btn.style.display = 'inline-flex';
});

window.addEventListener('appinstalled', function() {
  deferredInstallPrompt = null;
  const btn = document.getElementById('installEnclaveBtn');
  if (btn) btn.style.display = 'none';
});

// ─── Render: loading screen ───────────────────────────────────────────────────
export var renderLoading = function(msg) {
  var app = document.getElementById('app');
  app.innerHTML = '<div id="loading">' + (msg || 'Loading...') + '</div>';
};

// ─── Render: login screen ─────────────────────────────────────────────────────
export var renderLogin = function() {
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
export var renderShell = function() {
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

    // Sign out + install button
    var signOutBtn = document.querySelector('[data-action="sign-out"]');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', handleSignOut);

      // Inject install button before the sign-out button
      var installBtnEl = document.createElement('button');
      installBtnEl.id = 'installEnclaveBtn';
      installBtnEl.className = 'btn btn-ghost';
      installBtnEl.style.cssText = 'display:none;font-size:13px;';
      installBtnEl.title = 'Install Enclave on this device';
      installBtnEl.textContent = '↓ Install';
      signOutBtn.parentNode.insertBefore(installBtnEl, signOutBtn);
    }

    // Wire install prompt click handler
    const installBtn = document.getElementById('installEnclaveBtn');
    if (installBtn) {
      if (deferredInstallPrompt) {
        installBtn.style.display = 'inline-flex';
      }
      installBtn.addEventListener('click', async function() {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        installBtn.style.display = 'none';
        console.log('[Enclave] PWA install outcome:', outcome);
      });
    }

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

      // Inject sign-out at bottom of More menu (mobile users have no other way to sign out)
      moreMenu.insertAdjacentHTML('beforeend',
        '<hr style="border:0;border-top:1px solid var(--border);margin:8px 0" />' +
        '<button id="mobileMoreSignOut" class="mobile-more-item" style="color:var(--red);">' +
          '<span class="mobile-more-icon">⏻</span>' +
          '<span>Sign out</span>' +
        '</button>'
      );
      var mobileSignOutBtn = document.getElementById('mobileMoreSignOut');
      if (mobileSignOutBtn) {
        mobileSignOutBtn.addEventListener('click', function() {
          moreMenu.classList.remove('open');
          handleSignOut();
        });
      }
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

// ─── Presence ─────────────────────────────────────────────────────────────────
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

// ─── Panel: circles ───────────────────────────────────────────────────────────
export var loadPanelCircles = function() {
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
