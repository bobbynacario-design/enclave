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

var ALL_CIRCLES = [
  'hustle-hub',
  'work-network',
  'family'
];

var FEED_PAGE_SIZE = 20;

// ─── State ───────────────────────────────────────────────────────────────────
var state = {
  currentPage:  'feed',
  user:         null,
  accessDenied: false,
  isAdmin:      false,
  circles:      [],
  googleAccessToken: ''
};

var authFlowState = {
  busy: false
};

var eventsState = {
  upcoming: [],
  past: []
};

var feedState = {
  livePosts:   [],
  olderPosts:  [],
  filter:      'all',
  unsubscribe: null,
  hasMore:     false,
  loadingMore: false,
  lastDoc:     null,
  openComments: {},
  targetPostId: '',
  pendingTargetScroll: false
};

var membersState = {
  members: []
};

var adminState = {
  allowlist: []
};

var messagesState = {
  members:                 [],
  conversations:           [],
  activePeerId:            null,
  activeConversationId:    null,
  thread:                  [],
  olderMessages:           [],
  hasMoreMessages:         false,
  loadingOlder:            false,
  oldestDoc:               null,
  totalUnread:             0,
  unsubscribeConversations: null,
  unsubscribeThread:        null
};

// Drive attachment state for compose box
var driveAttachment = {
  fileUrl:  '',
  fileName: '',
  iconUrl:  ''
};


var shellState = {
  unsubscribeOnline: null,
  presenceTimer:     null
};

var resetMessagesState = function(fullReset) {
  if (messagesState.unsubscribeThread) {
    messagesState.unsubscribeThread();
    messagesState.unsubscribeThread = null;
  }

  messagesState.activePeerId = null;
  messagesState.activeConversationId = null;
  messagesState.thread = [];

  if (fullReset !== false) {
    if (messagesState.unsubscribeConversations) {
      messagesState.unsubscribeConversations();
      messagesState.unsubscribeConversations = null;
    }

    messagesState.members = [];
    messagesState.conversations = [];
    messagesState.totalUnread = 0;
  }
};

var resetShellRealtime = function() {
  if (shellState.unsubscribeOnline) {
    shellState.unsubscribeOnline();
    shellState.unsubscribeOnline = null;
  }

  if (shellState.presenceTimer) {
    window.clearInterval(shellState.presenceTimer);
    shellState.presenceTimer = null;
  }
};

var resetProjectDetailState = function() {
  if (projectsState.detailUnsubscribe) {
    projectsState.detailUnsubscribe();
    projectsState.detailUnsubscribe = null;
  }

  if (projectsState.commentsUnsubscribe) {
    projectsState.commentsUnsubscribe();
    projectsState.commentsUnsubscribe = null;
  }

  if (projectsState.filesUnsubscribe) {
    projectsState.filesUnsubscribe();
    projectsState.filesUnsubscribe = null;
  }

  if (projectsState.tasksUnsubscribe) {
    projectsState.tasksUnsubscribe();
    projectsState.tasksUnsubscribe = null;
  }

  if (projectsState.activityUnsubscribe) {
    projectsState.activityUnsubscribe();
    projectsState.activityUnsubscribe = null;
  }

  projectsState.detailProject = null;
  projectsState.detailComments = [];
  projectsState.detailFiles = [];
  projectsState.detailTasks = [];
  projectsState.detailActivity = [];
};

var VALID_PAGES = {
  feed:     true,
  events:   true,
  members:  true,
  admin:    true,
  messages: true,
  projects: true,
  resources: true
};

var projectsState = {
  projects:           [],
  unsubscribe:        null,
  activeProjectId:    null,
  detailUnsubscribe:  null,
  commentsUnsubscribe: null,
  filesUnsubscribe:   null,
  sidebarUnsubscribe: null,
  editingProjectId:   null,
  detailProject:      null,
  detailComments:     [],
  detailFiles:        [],
  detailTasks:        [],
  tasksUnsubscribe:   null,
  taskFilter:         'all',
  detailActivity:     [],
  activityUnsubscribe: null
};

var resourcesState = {
  resources:   [],
  unsubscribe: null,
  filter:      'all'
};

var pickerContext = 'feed';
var pickerProjectId = null;

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
    console.error('Sign-out error:', err);
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
    console.error('Sign-in error:', err);
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
        console.error('User bootstrap failed:', err);
        applyURLState();
        renderShell();
      });
    } else {
      runSignOut(true);
    }
  }).catch(function(err) {
    console.error('Allowlist check failed:', err);
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
        console.error('User doc update failed:', err);
      });
    } else {
      state.circles = allowedCircles.slice();
      base.joinedAt = serverTimestamp();
      base.bio      = '';
      base.role     = '';
      base.circles  = allowedCircles.slice();
      return setDoc(ref, base).catch(function(err) {
        console.error('User doc create failed:', err);
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
      '</div>' +
    '</div>';

  document.getElementById('googleSignInBtn').addEventListener('click', handleSignIn);
};

// Cache-buster for HTML fragment fetches — bumped per release to defeat
// browser/CDN caching of components and pages.
var ASSET_VERSION = 'v98';

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
      btn.hidden = getVisibleCircles().indexOf(btn.dataset.circle) === -1;
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
    loadOnlineUsers();
    startPresenceHeartbeat();
    loadPanelEvents();
    loadPanelCircles();
    loadSidebarProjects();
    syncResponsivePanels();
    loadPage(state.currentPage);
  }).catch(function(err) {
    console.error('Failed to load shell:', err);
    appEl.innerHTML = '<div id="loading">Failed to load shell.</div>';
  });
};

window.enclaveGoPage = function(page) {
  if (page === 'admin' && state.user) {
    refreshCurrentUserState().then(function() {
      loadPage('admin');
    }).catch(function(err) {
      console.error('Failed to refresh user state before admin nav:', err);
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
      btn.hidden = getVisibleCircles().indexOf(btn.dataset.circle) === -1;
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

    if (circle && getVisibleCircles().indexOf(circle) !== -1) {
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

var renderTimeOptions = function(selectedValue) {
  var options = [];

  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute += 30) {
      var hh = String(hour).padStart(2, '0');
      var mm = String(minute).padStart(2, '0');
      var value = hh + ':' + mm;
      var labelDate = new Date(2000, 0, 1, hour, minute);
      var label = labelDate.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      });
      var selected = value === selectedValue ? ' selected' : '';
      options.push('<option value="' + value + '"' + selected + '>' + escapeHTML(label) + '</option>');
    }
  }

  return options.join('');
};

var calendarPickerState = {
  activeFieldId: '',
  fields: {}
};

var formatDateValue = function(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  var year = String(date.getFullYear());
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
};

var parseDateValue = function(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;

  var parts = value.split('-');
  var year = Number(parts[0]);
  var month = Number(parts[1]) - 1;
  var day = Number(parts[2]);
  var date = new Date(year, month, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
};

var formatDateButtonLabel = function(value) {
  var date = parseDateValue(value);
  if (!date) return 'Select a date';

  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

var formatCalendarMonthLabel = function(year, month) {
  return new Date(year, month, 1).toLocaleDateString([], {
    month: 'long',
    year: 'numeric'
  });
};

var renderDatePickerField = function(inputId, label, value) {
  return '' +
    '<label class="profile-section-title" for="' + inputId + 'Trigger">' + escapeHTML(label) + '</label>' +
    '<div class="calendar-field" data-calendar-field="' + escapeAttr(inputId) + '">' +
      '<input type="hidden" id="' + escapeAttr(inputId) + '" value="' + escapeAttr(value) + '" />' +
      '<button type="button" id="' + escapeAttr(inputId) + 'Trigger" class="edit-input calendar-trigger" aria-haspopup="dialog" aria-expanded="false">' +
        '<span class="calendar-trigger-label">' + escapeHTML(formatDateButtonLabel(value)) + '</span>' +
        '<span class="calendar-trigger-icon">&#128197;</span>' +
      '</button>' +
      '<div class="calendar-popover" id="' + escapeAttr(inputId) + 'Popover" hidden></div>' +
    '</div>';
};

var closeActiveCalendarPicker = function() {
  var fieldId = calendarPickerState.activeFieldId;
  if (!fieldId) return;

  var field = calendarPickerState.fields[fieldId];
  calendarPickerState.activeFieldId = '';

  if (!field) return;

  field.popover.hidden = true;
  field.trigger.setAttribute('aria-expanded', 'false');
  field.wrapper.classList.remove('calendar-open');
};

var renderCalendarPopover = function(fieldId) {
  var field = calendarPickerState.fields[fieldId];
  if (!field) return;

  var selectedValue = field.hidden.value;
  var todayValue = formatDateValue(new Date());
  var firstDay = new Date(field.viewYear, field.viewMonth, 1).getDay();
  var daysInMonth = new Date(field.viewYear, field.viewMonth + 1, 0).getDate();
  var weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var cells = [];

  for (var blank = 0; blank < firstDay; blank++) {
    cells.push('<span class="calendar-day calendar-day-empty" aria-hidden="true"></span>');
  }

  for (var day = 1; day <= daysInMonth; day++) {
    var dateValue = formatDateValue(new Date(field.viewYear, field.viewMonth, day));
    var classes = ['calendar-day'];

    if (dateValue === selectedValue) classes.push('is-selected');
    if (dateValue === todayValue) classes.push('is-today');

    cells.push(
      '<button type="button" class="' + classes.join(' ') + '" data-calendar-date="' + dateValue + '">' +
        day +
      '</button>'
    );
  }

  field.popover.innerHTML =
    '<div class="calendar-shell">' +
      '<div class="calendar-toolbar">' +
        '<button type="button" class="calendar-nav-btn" data-calendar-nav="prev" aria-label="Previous month">&#8249;</button>' +
        '<div class="calendar-month-label">' + escapeHTML(formatCalendarMonthLabel(field.viewYear, field.viewMonth)) + '</div>' +
        '<button type="button" class="calendar-nav-btn" data-calendar-nav="next" aria-label="Next month">&#8250;</button>' +
      '</div>' +
      '<div class="calendar-weekdays">' +
        weekdayLabels.map(function(label) {
          return '<span class="calendar-weekday">' + label + '</span>';
        }).join('') +
      '</div>' +
      '<div class="calendar-grid">' + cells.join('') + '</div>' +
    '</div>';
};

var bindDatePickerField = function(inputId) {
  var wrapper = document.querySelector('[data-calendar-field="' + inputId + '"]');
  var hidden = document.getElementById(inputId);
  var trigger = document.getElementById(inputId + 'Trigger');
  var popover = document.getElementById(inputId + 'Popover');

  if (!wrapper || !hidden || !trigger || !popover) return;

  var selectedDate = parseDateValue(hidden.value) || new Date();
  var field = {
    wrapper: wrapper,
    hidden: hidden,
    trigger: trigger,
    popover: popover,
    viewYear: selectedDate.getFullYear(),
    viewMonth: selectedDate.getMonth(),
    updateLabel: function() {
      var label = trigger.querySelector('.calendar-trigger-label');
      if (label) {
        label.textContent = formatDateButtonLabel(hidden.value);
      }
    }
  };

  calendarPickerState.fields[inputId] = field;
  field.updateLabel();
  renderCalendarPopover(inputId);

  trigger.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();

    var isOpening = calendarPickerState.activeFieldId !== inputId || popover.hidden;
    closeActiveCalendarPicker();

    if (!isOpening) return;

    var currentDate = parseDateValue(hidden.value) || new Date();
    field.viewYear = currentDate.getFullYear();
    field.viewMonth = currentDate.getMonth();
    renderCalendarPopover(inputId);
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    wrapper.classList.add('calendar-open');
    calendarPickerState.activeFieldId = inputId;
  });

  popover.addEventListener('click', function(e) {
    var navBtn = e.target.closest('[data-calendar-nav]');
    if (navBtn) {
      if (navBtn.dataset.calendarNav === 'prev') {
        field.viewMonth -= 1;
        if (field.viewMonth < 0) {
          field.viewMonth = 11;
          field.viewYear -= 1;
        }
      } else {
        field.viewMonth += 1;
        if (field.viewMonth > 11) {
          field.viewMonth = 0;
          field.viewYear += 1;
        }
      }

      renderCalendarPopover(inputId);
      return;
    }

    var dayBtn = e.target.closest('[data-calendar-date]');
    if (!dayBtn) return;

    hidden.value = dayBtn.dataset.calendarDate;
    field.updateLabel();
    renderCalendarPopover(inputId);
    closeActiveCalendarPicker();
  });
};

document.addEventListener('click', function(e) {
  var fieldId = calendarPickerState.activeFieldId;
  if (!fieldId) return;

  var field = calendarPickerState.fields[fieldId];
  if (!field || !field.wrapper.contains(e.target)) {
    closeActiveCalendarPicker();
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeActiveCalendarPicker();
  }
});

var getUpcomingEventsThreshold = function() {
  return Timestamp.fromDate(new Date(Date.now() - 3600000));
};

var getOnlineUsersThreshold = function() {
  return Timestamp.fromDate(new Date(Date.now() - 5 * 60000));
};

var updatePresenceHeartbeat = function() {
  if (!state.user) return;

  updateDoc(doc(db, 'users', state.user.uid), {
    lastSeen: serverTimestamp()
  }).catch(function(err) {
    console.error('Failed to update presence heartbeat:', err);
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
    console.error('Failed to load online users:', err);
    el.className = 'panel-empty';
    el.textContent = 'Failed to load online users.';
  });
};

// ─── Right panel: upcoming events ────────────────────────────────────────────
var loadPanelEvents = function() {
  var el = document.getElementById('panelEvents');
  if (!el) {
    return;
  }

  var q = query(
    collection(db, 'events'),
    where('circle', 'in', getVisibleCircles()),
    where('date', '>=', getUpcomingEventsThreshold()),
    orderBy('date', 'asc'),
    limit(4)
  );
  getDocs(q).then(function(snap) {
    var items = [];
    snap.forEach(function(d) {
      var data = d.data();
      items.push(data);
    });

    if (items.length === 0) {
      el.className = 'panel-empty';
      el.textContent = 'No upcoming events.';
      return;
    }

    el.className = 'panel-events';
    el.innerHTML = items.map(function(ev) {
      var titleEsc = escapeHTML(ev.title || 'Untitled');
      var when = '';
      if (ev.date && typeof ev.date.toDate === 'function') {
        var d = ev.date.toDate();
        when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
          ' · ' +
          d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      }
      var locEsc = escapeHTML(ev.location || '');
      return '' +
        '<div class="panel-event">' +
          '<div class="panel-event-title">' + titleEsc + '</div>' +
          '<div class="panel-event-meta">' + escapeHTML(when) + '</div>' +
          (locEsc ? '<div class="panel-event-meta">' + locEsc + '</div>' : '') +
        '</div>';
    }).join('');
  }).catch(function(err) {
    console.error('Failed to load panel events:', err);
    el.className = 'panel-empty';
    el.textContent = 'Failed to load events.';
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
  }).catch(function(err) {
    console.error('Failed to load page ' + page + ':', err);
    slot.innerHTML = '<div class="card"><p class="text-muted">Failed to load ' + page + '.</p></div>';
  });
};

// ─── Feed: init ──────────────────────────────────────────────────────────────
var initFeedPage = function() {
  var visibleCircles = getVisibleCircles();
  var composeCircle = document.getElementById('composeCircle');
  var filterPills = document.querySelector('.filter-pills');

  if (visibleCircles.indexOf(feedState.filter) === -1) {
    feedState.filter = 'all';
  }

  var composeAv = document.querySelector('[data-slot="compose-avatar"]');
  if (composeAv && state.user) {
    if (state.user.photoURL) {
      composeAv.style.backgroundImage = 'url(' + escapeAttr(state.user.photoURL) + ')';
      composeAv.textContent = '';
    } else {
      composeAv.textContent = getInitials(state.user.displayName || state.user.email);
    }
  }

  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn) submitBtn.addEventListener('click', handleComposeSubmit);

  // Drive attachment
  var driveBtn = document.getElementById('driveAttachBtn');
  if (driveBtn) driveBtn.addEventListener('click', openDrivePicker);
  clearDriveAttachment();

  if (composeCircle) {
    composeCircle.innerHTML = renderCircleOptions(true);
  }

  if (composeCircle) {
    composeCircle.querySelectorAll('option').forEach(function(option) {
      option.hidden = visibleCircles.indexOf(option.value) === -1;
    });

    if (visibleCircles.indexOf(composeCircle.value) === -1) {
      composeCircle.value = 'all';
    }
  }

  if (filterPills) {
    filterPills.innerHTML = renderCirclePills();
  }

  document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
    pill.hidden = visibleCircles.indexOf(pill.dataset.filter) === -1;
  });

  document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
    pill.addEventListener('click', function() {
      feedState.filter = pill.dataset.filter;
      feedState.targetPostId = '';
      feedState.pendingTargetScroll = false;
      syncURLState();
      document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
        p.classList.toggle('active', p === pill);
      });
      syncSidebarSelection();
      renderFeedList();
    });
  });

  document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
    p.classList.toggle('active', p.dataset.filter === feedState.filter);
  });

  syncSidebarSelection();
  subscribeFeed();
};

// ─── Feed: live subscription ─────────────────────────────────────────────────
var subscribeFeed = function() {
  feedState.livePosts = [];
  feedState.olderPosts = [];
  feedState.hasMore = false;
  feedState.loadingMore = false;
  feedState.lastDoc = null;

  var q = query(
    collection(db, 'posts'),
    where('circle', 'in', getVisibleCircles()),
    orderBy('timestamp', 'desc'),
    limit(FEED_PAGE_SIZE)
  );

  feedState.unsubscribe = onSnapshot(q, function(snap) {
    feedState.livePosts = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      feedState.livePosts.push(data);
    });

    if (snap.empty) {
      if (feedState.olderPosts.length === 0) {
        feedState.lastDoc = null;
      }
      feedState.hasMore = false;
    } else {
      if (feedState.olderPosts.length === 0 || !feedState.lastDoc) {
        feedState.lastDoc = snap.docs[snap.docs.length - 1];
      }
      feedState.hasMore = snap.docs.length === FEED_PAGE_SIZE;
    }

    ensureTargetPostLoaded().then(function() {
      renderFeedList();
    });
  }, function(err) {
    console.error('Feed subscribe error:', err);
    var list = document.getElementById('feedList');
    if (list) list.innerHTML = '<div class="card"><p class="text-muted">Failed to load feed. Check Firestore rules.</p></div>';
  });
};

var getAllKnownFeedPosts = function() {
  var combined = [];
  var seen = {};

  feedState.livePosts.concat(feedState.olderPosts).forEach(function(post) {
    if (!post || !post.id || seen[post.id]) return;
    seen[post.id] = true;
    combined.push(post);
  });

  return combined;
};

var ensureTargetPostLoaded = function() {
  if (!feedState.targetPostId) return Promise.resolve(false);

  var alreadyLoaded = getAllKnownFeedPosts().some(function(post) {
    return post.id === feedState.targetPostId;
  });
  if (alreadyLoaded) return Promise.resolve(true);

  return getDoc(doc(db, 'posts', feedState.targetPostId)).then(function(snap) {
    if (!snap.exists()) return false;

    var data = snap.data() || {};
    data.id = snap.id;

    if (getVisibleCircles().indexOf(data.circle || 'all') === -1) {
      return false;
    }

    feedState.olderPosts = [data].concat(feedState.olderPosts.filter(function(post) {
      return post.id !== data.id;
    }));
    return true;
  }).catch(function(err) {
    console.error('Failed to load shared post:', err);
    return false;
  });
};

var getRenderedFeedPosts = function() {
  var combined = getAllKnownFeedPosts();

  if (feedState.filter !== 'all') {
    combined = combined.filter(function(post) {
      return post.circle === feedState.filter;
    });
  }

  // Pinned posts float to top
  var pinned = combined.filter(function(post) { return post.isPinned; });
  var unpinned = combined.filter(function(post) { return !post.isPinned; });
  combined = pinned.concat(unpinned);

  if (feedState.targetPostId) {
    var targetIndex = combined.findIndex(function(post) {
      return post.id === feedState.targetPostId;
    });

    if (targetIndex > 0) {
      var targetPost = combined.splice(targetIndex, 1)[0];
      combined.unshift(targetPost);
    }
  }

  return combined;
};

var scrollToTargetPost = function() {
  if (!feedState.targetPostId || !feedState.pendingTargetScroll) return;

  var card = document.querySelector('[data-post-id="' + feedState.targetPostId + '"]');
  if (!card) return;

  feedState.pendingTargetScroll = false;

  window.requestAnimationFrame(function() {
    card.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  });
};

var loadMoreFeedPosts = function() {
  if (feedState.loadingMore || !feedState.lastDoc) return;

  feedState.loadingMore = true;
  renderFeedList();

  var q = query(
    collection(db, 'posts'),
    where('circle', 'in', getVisibleCircles()),
    orderBy('timestamp', 'desc'),
    startAfter(feedState.lastDoc),
    limit(FEED_PAGE_SIZE)
  );

  getDocs(q).then(function(snap) {
    var nextPosts = [];

    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      nextPosts.push(data);
    });

    feedState.olderPosts = feedState.olderPosts.concat(nextPosts);
    feedState.hasMore = snap.docs.length === FEED_PAGE_SIZE;

    if (!snap.empty) {
      feedState.lastDoc = snap.docs[snap.docs.length - 1];
    }
  }).catch(function(err) {
    console.error('Failed to load more posts:', err);
    showToast('Failed to load more posts. Check console for details.', 'error');
  }).finally(function() {
    feedState.loadingMore = false;
    ensureTargetPostLoaded().then(function() {
      renderFeedList();
    });
  });
};

// ─── Feed: compose submit ────────────────────────────────────────────────────
var handleComposeSubmit = function() {
  var bodyEl   = document.getElementById('composeBody');
  var circleEl = document.getElementById('composeCircle');
  if (!bodyEl || !circleEl || !state.user) return;

  var body   = bodyEl.value.trim();
  var circle = circleEl.value;
  if (!body && !driveAttachment.fileUrl) {
    showToast('Write something or attach a file.', 'error');
    return;
  }

  var displayName = state.user.displayName || state.user.email;

  var post = {
    authorId:       state.user.uid,
    authorName:     displayName,
    authorInitials: getInitials(displayName),
    circle:         circle,
    body:           body,
    timestamp:      serverTimestamp(),
    reacts:         [],
    comments:       []
  };

  // Attach Drive file if present
  if (driveAttachment.fileUrl) {
    post.fileUrl  = driveAttachment.fileUrl;
    post.fileName = driveAttachment.fileName;
    post.fileIcon = driveAttachment.iconUrl;
  }

  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn) {
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Posting...';
  }

  var savePost = function(postData) {
    addDoc(collection(db, 'posts'), postData).then(function() {
      bodyEl.value = '';
      clearDriveAttachment();
      if (submitBtn) {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Post';
      }
    }).catch(function(err) {
      console.error('Failed to post:', err);
      if (submitBtn) {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Post';
      }
      showToast('Failed to post. Check console for details.', 'error');
    });
  };

  // Preserve the first URL for a local-only fallback preview card.
  var firstUrl = extractFirstUrl(body);
  if (firstUrl) {
    post.ogUrl = firstUrl;
    try {
      post.ogSite = new URL(firstUrl).hostname.replace(/^www\./, '');
    } catch (e) {}
  }

  savePost(post);
};

// ─── Feed: render list ───────────────────────────────────────────────────────
var renderFeedList = function() {
  var list = document.getElementById('feedList');
  if (!list) return;

  var posts = getRenderedFeedPosts();

  if (posts.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No posts yet. Be the first to share.</p></div>';
  } else {
    list.innerHTML = posts.map(renderPostCard).join('');
  }

  if (feedState.hasMore) {
    list.insertAdjacentHTML('beforeend',
      '<div class="feed-load-more">' +
        '<button class="btn btn-ghost load-more-btn" type="button">' +
          (feedState.loadingMore ? 'Loading...' : 'Load more') +
        '</button>' +
      '</div>'
    );
  }

  list.querySelectorAll('[data-toggle-comments-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      togglePostComments(btn.dataset.toggleCommentsPost, btn.dataset.postAuthor);
    });
  });

  list.querySelectorAll('[data-comment-form]').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      handleCommentSubmit(form.dataset.commentForm, form.dataset.postAuthor, form);
    });
  });

  list.querySelectorAll('[data-react-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleReactPost(btn.dataset.reactPost);
    });
  });

  list.querySelectorAll('[data-share-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleSharePost(btn.dataset.sharePost);
    });
  });

  list.querySelectorAll('[data-delete-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleDeletePost(btn.dataset.deletePost, btn.dataset.postAuthor);
    });
  });

  list.querySelectorAll('[data-pin-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handlePinPost(btn.dataset.pinPost);
    });
  });

  var loadMoreBtn = list.querySelector('.load-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = feedState.loadingMore;
    loadMoreBtn.addEventListener('click', loadMoreFeedPosts);
  }

  scrollToTargetPost();
};

// ─── Feed: render single post card ───────────────────────────────────────────
var renderPostComments = function(postId, comments, authorId) {
  var items = comments.map(function(comment) {
    if (typeof comment === 'string') {
      return '<div class="post-comment"><div class="post-comment-body">' + escapeHTML(comment) + '</div></div>';
    }

    var commentAuthor = escapeHTML(comment.authorName || 'Member');
    var commentBody = escapeHTML(comment.body || '');
    var commentTime = 'just now';

    if (comment.createdAt && typeof comment.createdAt.toDate === 'function') {
      commentTime = relativeTime(comment.createdAt.toDate());
    }

    return '' +
      '<div class="post-comment">' +
        '<div class="post-comment-meta">' +
          '<span class="post-comment-author">' + commentAuthor + '</span>' +
          '<span class="post-dot">&middot;</span>' +
          '<span class="post-comment-time">' + escapeHTML(commentTime) + '</span>' +
        '</div>' +
        '<div class="post-comment-body">' + commentBody + '</div>' +
      '</div>';
  }).join('');

  if (!items) {
    items = '<div class="post-comments-empty">No comments yet.</div>';
  }

  return '' +
    '<div class="post-comments">' +
      '<div class="post-comments-list">' + items + '</div>' +
      '<form class="post-comment-compose" data-comment-form="' + escapeAttr(postId) + '" data-post-author="' + escapeAttr(authorId || '') + '">' +
        '<input class="post-comment-input" type="text" maxlength="280" placeholder="Write a comment..." data-comment-input="' + escapeAttr(postId) + '" />' +
        '<button class="btn btn-ghost post-comment-submit" type="submit">Send</button>' +
      '</form>' +
    '</div>';
};

var renderPostCard = function(p) {
  var circleLabels = {
    'all':          'All',
    'hustle-hub':   'Hustle Hub',
    'work-network': 'Work Network',
    'family':       'Family'
  };
  var circleLabel = circleLabels[p.circle] || p.circle || 'All';

  var time = (p.timestamp && typeof p.timestamp.toDate === 'function')
    ? relativeTime(p.timestamp.toDate())
    : 'just now';

  var nameEsc     = escapeHTML(p.authorName || 'Unknown');
  var initialsEsc = escapeHTML(p.authorInitials || '?');
  var bodyEsc     = linkifyText(escapeHTML(p.body || ''));
  var reacts = Array.isArray(p.reacts) ? p.reacts : [];
  var comments = Array.isArray(p.comments) ? p.comments : [];
  var reacted = state.user && reacts.indexOf(state.user.uid) !== -1;
  var reactBtnClass = reacted
    ? 'post-action post-react-btn post-action-active'
    : 'post-action post-react-btn';
  var commentsOpen = !!feedState.openComments[p.id];
  var commentBtnClass = commentsOpen
    ? 'post-action post-comment-btn post-action-active'
    : 'post-action post-comment-btn';
  var canDelete = state.user && (state.isAdmin || p.authorId === state.user.uid);
  var deleteBtn = canDelete
    ? '<button class="post-action post-action-danger" data-delete-post="' + escapeAttr(p.id) + '" data-post-author="' + escapeAttr(p.authorId) + '">Delete</button>'
    : '';
  var pinBtn = state.isAdmin
    ? '<button class="post-action" data-pin-post="' + escapeAttr(p.id) + '">' + (p.isPinned ? 'Unpin' : 'Pin') + '</button>'
    : '';
  var pinnedClass = p.isPinned ? ' post-pinned' : '';
  var pinnedBadge = p.isPinned ? '<span class="post-pinned-badge">Pinned</span>' : '';

  return '' +
    '<div class="post-card' + pinnedClass + (feedState.targetPostId === p.id ? ' post-card-target' : '') + '" data-post-id="' + escapeAttr(p.id) + '">' +
      pinnedBadge +
      '<div class="post-header">' +
        '<div class="post-avatar">' + initialsEsc + '</div>' +
        '<div class="post-meta">' +
          '<div class="post-author">' + nameEsc + '</div>' +
          '<div class="post-submeta">' +
            '<span class="post-circle">' + circleLabel + '</span>' +
            '<span class="post-dot">&middot;</span>' +
            '<span class="post-time">' + time + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="post-body">' + bodyEsc + '</div>' +
      (p.ogUrl ? renderLinkPreview(p) : '') +
      (p.fileUrl
        ? '<a class="post-attachment" href="' + escapeAttr(p.fileUrl) + '" target="_blank" rel="noopener">' +
            (p.fileIcon
              ? '<img src="' + escapeAttr(p.fileIcon) + '" class="post-attachment-icon" alt="" />'
              : '<span class="post-attachment-icon-fallback">&#128196;</span>') +
            '<span class="post-attachment-name">' + escapeHTML(p.fileName || 'Attached file') + '</span>' +
            '<span class="post-attachment-open">Open &#8599;</span>' +
          '</a>'
        : '') +
      '<div class="post-actions">' +
        '<button class="' + reactBtnClass + '" data-react-post="' + escapeAttr(p.id) + '">&#128077; ' + reacts.length + '</button>' +
        '<button class="' + commentBtnClass + '" data-toggle-comments-post="' + escapeAttr(p.id) + '" data-post-author="' + escapeAttr(p.authorId) + '">&#128172; ' + comments.length + '</button>' +
        '<button class="post-action" data-share-post="' + escapeAttr(p.id) + '">&#8599; Share</button>' +
        pinBtn +
        deleteBtn +
      '</div>' +
      (commentsOpen ? renderPostComments(p.id, comments, p.authorId) : '') +
    '</div>';
};

var handleSharePost = function(postId) {
  var post = getAllKnownFeedPosts().find(function(item) {
    return item.id === postId;
  });
  if (!post) return;

  var author = post.authorName || 'Someone';
  var body = String(post.body || '').trim();
  var summary = body.length > 140
    ? body.slice(0, 137) + '...'
    : body;
  var shareURL = getAppURL() + '?page=feed&postId=' + encodeURIComponent(postId);
  var shareText = author + ' in Enclave: ' + summary;

  if (navigator.share) {
    navigator.share({
      title: 'Enclave Post',
      text: shareText,
      url: shareURL
    }).catch(function() {
      // Ignore cancelled shares.
    });
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareText + '\n\n' + shareURL).then(function() {
      showToast('Post link copied.', 'success');
    }).catch(function(err) {
      console.error('Failed to copy share text:', err);
      showToast('Unable to share this post right now.', 'error');
    });
    return;
  }

  showNoticeModal('Share this post', shareText + '\n\n' + shareURL);
};

var updateKnownPostReacts = function(postId, reacts) {
  [feedState.livePosts, feedState.olderPosts].forEach(function(posts) {
    posts.forEach(function(post) {
      if (post.id === postId) {
        post.reacts = reacts.slice();
      }
    });
  });
};

var updateKnownPostComments = function(postId, comments) {
  [feedState.livePosts, feedState.olderPosts].forEach(function(posts) {
    posts.forEach(function(post) {
      if (post.id === postId) {
        post.comments = comments.slice();
      }
    });
  });
};

var togglePostComments = function(postId, authorId) {
  if (!postId) return;

  feedState.openComments[postId] = !feedState.openComments[postId];
  renderFeedList();

  if (authorId && document.getElementById('profilePosts')) {
    loadRecentPosts(authorId);
  }
};

var handleReactPost = function(postId) {
  if (!state.user) return;

  var ref = doc(db, 'posts', postId);
  var post = getAllKnownFeedPosts().find(function(item) {
    return item.id === postId;
  });
  var authorId = post && post.authorId ? post.authorId : null;
  var nextReacts = null;
  var uid = state.user.uid;

  runTransaction(db, function(tx) {
    return tx.get(ref).then(function(snap) {
      if (!snap.exists()) return;

      var current = Array.isArray(snap.data().reacts) ? snap.data().reacts.slice() : [];
      var idx = current.indexOf(uid);

      if (idx === -1) {
        current.push(uid);
      } else {
        current.splice(idx, 1);
      }

      nextReacts = current.slice();
      tx.update(ref, { reacts: current });
    });
  }).then(function() {
    if (!nextReacts) return;

    updateKnownPostReacts(postId, nextReacts);
    renderFeedList();

    if (authorId && document.getElementById('profilePosts')) {
      loadRecentPosts(authorId);
    }
  }).catch(function(err) {
    console.error('React failed:', err);
    showToast('Could not save reaction. Try again.', 'error');
  });
};

var handleCommentSubmit = function(postId, authorId, formEl) {
  if (!state.user || !postId) return;

  var input = formEl
    ? formEl.querySelector('[data-comment-input]')
    : document.querySelector('[data-comment-input="' + postId + '"]');
  if (!input) return;

  var body = input.value.trim();
  if (!body) return;

  var ref = doc(db, 'posts', postId);
  var nextComments = null;
  var comment = {
    uid: state.user.uid,
    authorName: state.user.displayName || state.user.email || 'Member',
    body: body,
    createdAt: Timestamp.now()
  };

  input.disabled = true;

  runTransaction(db, function(tx) {
    return tx.get(ref).then(function(snap) {
      if (!snap.exists()) return;

      var current = Array.isArray(snap.data().comments) ? snap.data().comments.slice() : [];
      current.push(comment);
      nextComments = current.slice();
      tx.update(ref, { comments: current });
    });
  }).then(function() {
    if (!nextComments) return;

    updateKnownPostComments(postId, nextComments);
    feedState.openComments[postId] = true;
    renderFeedList();

    if (authorId && document.getElementById('profilePosts')) {
      loadRecentPosts(authorId);
    }
  }).catch(function(err) {
    console.error('Comment failed:', err);
    showToast('Could not save comment. Try again.', 'error');
  }).finally(function() {
    input.disabled = false;
  });
};

var handleDeletePost = function(postId, authorId) {
  if (!postId) return;

  showConfirmModal('Delete post', 'Delete this post?', 'Delete').then(function(confirmed) {
    if (!confirmed) return;

    deleteDoc(doc(db, 'posts', postId)).then(function() {
      if (authorId && document.getElementById('profilePosts')) {
        loadRecentPosts(authorId);
      }
      showToast('Post deleted.', 'success');
    }).catch(function(err) {
      console.error('Failed to delete post:', err);
      showToast('Failed to delete post. Check console for details.', 'error');
    });
  });
};

var handlePinPost = function(postId) {
  if (!postId || !state.isAdmin) return;
  var post = getAllKnownFeedPosts().find(function(p) { return p.id === postId; });
  if (!post) return;
  var newPinned = !post.isPinned;
  updateDoc(doc(db, 'posts', postId), { isPinned: newPinned }).then(function() {
    post.isPinned = newPinned;
    renderFeedList();
    showToast(newPinned ? 'Post pinned.' : 'Post unpinned.', 'info');
  }).catch(function(err) {
    console.error('Pin post error:', err);
    showToast('Failed to pin post.', 'error');
  });
};

// ─── Members: init ───────────────────────────────────────────────────────────
var initMembersPage = function() {
  loadMembers();

  // Delegate close handlers on the modal
  document.querySelectorAll('[data-action="close-profile"]').forEach(function(el) {
    el.addEventListener('click', closeProfile);
  });
};

// ─── Members: load ───────────────────────────────────────────────────────────
var loadMembers = function() {
  var list = document.getElementById('membersList');
  if (!list) return;

  getDocs(collection(db, 'users')).then(function(usersSnap) {
    var members = [];
    usersSnap.forEach(function(d) {
      var data = d.data();
      data.uid = d.id;
      members.push(data);
    });

    // Sort alphabetically by name
    members.sort(function(a, b) {
      return (a.name || '').localeCompare(b.name || '');
    });

    membersState.members = members;
    renderMembersList();
  }).catch(function(err) {
    console.error('Failed to load members:', err);
    list.innerHTML = '<div class="card"><p class="text-muted">Failed to load members. Check Firestore rules.</p></div>';
  });
};

// ─── Admin: init ──────────────────────────────────────────────────────────────
// ─── Messages ────────────────────────────────────────────────────────────────
var getConversationId = function(uidA, uidB) {
  return [uidA, uidB].sort().join('__');
};

var getConversationPeerId = function(conversation) {
  var members = Array.isArray(conversation.members) ? conversation.members : [];
  return members.filter(function(uid) {
    return uid !== (state.user && state.user.uid);
  })[0] || null;
};

var getConversationSortValue = function(conversation) {
  var ts = conversation.updatedAt || conversation.createdAt;
  if (ts && typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
  return 0;
};

var findMessageMember = function(uid) {
  return messagesState.members.find(function(member) {
    return member.uid === uid;
  }) || null;
};

var findConversationForPeer = function(peerId) {
  return messagesState.conversations.find(function(conversation) {
    return getConversationPeerId(conversation) === peerId;
  }) || null;
};

var getConversationUnreadCount = function(conversation) {
  if (!conversation || !state.user) return 0;

  var unreadCount = conversation.unreadCount || {};
  var value = unreadCount[state.user.uid];
  return typeof value === 'number' && value > 0 ? value : 0;
};

var syncMessagesUnreadState = function() {
  var total = 0;

  messagesState.conversations.forEach(function(conversation) {
    total += getConversationUnreadCount(conversation);
  });

  messagesState.totalUnread = total;

  document.querySelectorAll('[data-page="messages"]').forEach(function(link) {
    var badge = link.querySelector('.messages-nav-badge');
    if (total > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'messages-nav-badge';
        link.appendChild(badge);
      }
      badge.textContent = total > 99 ? '99+' : String(total);
    } else if (badge) {
      badge.remove();
    }
  });

  var sidebarHeader = document.getElementById('messagesSidebarHeader');
  if (sidebarHeader) {
    sidebarHeader.innerHTML = 'People' + (
      total > 0
        ? '<span class="messages-sidebar-count">' + escapeHTML(total > 99 ? '99+' : String(total)) + ' unread</span>'
        : ''
    );
  }
};

var markConversationRead = function(conversationId) {
  if (!state.user || !conversationId) return Promise.resolve();

  var conversation = messagesState.conversations.find(function(item) {
    return item.id === conversationId;
  });
  if (!conversation) return Promise.resolve();

  var unread = getConversationUnreadCount(conversation);
  if (unread <= 0) return Promise.resolve();

  if (!conversation.unreadCount) conversation.unreadCount = {};
  conversation.unreadCount[state.user.uid] = 0;
  if (!conversation.readBy) conversation.readBy = {};
  conversation.readBy[state.user.uid] = Timestamp.now();
  syncMessagesUnreadState();
  renderMessagesPeopleList();

  var payload = {};
  payload['unreadCount.' + state.user.uid] = 0;
  payload['readBy.' + state.user.uid] = serverTimestamp();

  return updateDoc(doc(db, 'conversations', conversationId), payload).catch(function(err) {
    console.error('Failed to mark conversation read:', err);
  });
};

var renderMessagesPeopleList = function() {
  var list = document.getElementById('messagesPeopleList');
  if (!list) return;

  if (messagesState.members.length === 0) {
    list.innerHTML = '<div class="messages-empty-state text-muted">No other members found yet.</div>';
    return;
  }

  var convByPeer = {};
  messagesState.conversations.forEach(function(conversation) {
    var peerId = getConversationPeerId(conversation);
    if (peerId) convByPeer[peerId] = conversation;
  });

  var members = messagesState.members.slice().sort(function(a, b) {
    var convA = convByPeer[a.uid];
    var convB = convByPeer[b.uid];

    if (convA && convB) {
      return getConversationSortValue(convB) - getConversationSortValue(convA);
    }
    if (convA) return -1;
    if (convB) return 1;
    return (a.name || a.email || '').localeCompare(b.name || b.email || '');
  });

  syncMessagesUnreadState();

  list.innerHTML = members.map(function(member) {
    var active = member.uid === messagesState.activePeerId ? ' active' : '';
    var initials = escapeHTML(getInitials(member.name || member.email || '?'));
    var name = escapeHTML(member.name || member.email || 'Member');
    var meta = escapeHTML(member.role || member.email || '');
    var conversation = convByPeer[member.uid] || null;
    var unread = getConversationUnreadCount(conversation);
    var preview = conversation && conversation.lastMessage
      ? escapeHTML(conversation.lastMessage)
      : 'No messages yet.';

    return '' +
      '<button class="messages-person' + active + (unread > 0 ? ' unread' : '') + '" type="button" data-open-message="' + escapeAttr(member.uid) + '">' +
        '<div class="messages-person-avatar">' + initials + '</div>' +
        '<div class="messages-person-meta">' +
          '<div class="messages-person-name-row">' +
            '<div class="messages-person-name">' + name + '</div>' +
            (unread > 0 ? '<span class="messages-unread-badge">' + escapeHTML(unread > 99 ? '99+' : String(unread)) + '</span>' : '') +
          '</div>' +
          '<div class="messages-person-subtitle">' + meta + '</div>' +
          '<div class="messages-person-preview">' + preview + '</div>' +
        '</div>' +
      '</button>';
  }).join('');

  list.querySelectorAll('[data-open-message]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openMessageThread(btn.dataset.openMessage);
    });
  });
};

var renderMessagesThread = function() {
  var titleEl = document.getElementById('messagesThreadTitle');
  var subtitleEl = document.getElementById('messagesThreadSubtitle');
  var listEl = document.getElementById('messagesThreadList');
  var inputEl = document.getElementById('messagesComposeInput');
  var sendBtn = document.getElementById('messagesSendBtn');

  if (!titleEl || !subtitleEl || !listEl || !inputEl || !sendBtn) return;

  var peer = findMessageMember(messagesState.activePeerId);
  if (!peer) {
    titleEl.textContent = 'Select a member';
    subtitleEl.textContent = 'Choose someone to start chatting.';
    listEl.innerHTML = '<div class="messages-empty-state text-muted">No conversation selected yet.</div>';
    inputEl.value = '';
    inputEl.disabled = true;
    sendBtn.disabled = true;
    return;
  }

  titleEl.textContent = peer.name || peer.email || 'Member';
  subtitleEl.textContent = peer.role || peer.email || 'Direct conversation';
  inputEl.disabled = false;
  sendBtn.disabled = false;

  var activeConversation = messagesState.conversations.find(function(conversation) {
    return conversation.id === messagesState.activeConversationId;
  }) || null;
  var peerReadAt = activeConversation && activeConversation.readBy
    ? activeConversation.readBy[peer.uid]
    : null;
  var peerReadAtMs = getFirestoreTimeMs(peerReadAt);
  var lastOwnMessageId = null;

  var allMsgs = messagesState.olderMessages.concat(messagesState.thread);
  for (var i = allMsgs.length - 1; i >= 0; i -= 1) {
    if (allMsgs[i].authorId === (state.user && state.user.uid)) {
      lastOwnMessageId = allMsgs[i].id;
      break;
    }
  }

  var allMessages = messagesState.olderMessages.concat(messagesState.thread);

  if (allMessages.length === 0) {
    listEl.innerHTML = '<div class="messages-empty-state text-muted">No messages yet. Send the first one.</div>';
    return;
  }

  var loadMoreHtml = messagesState.hasMoreMessages
    ? '<div style="text-align:center;padding:8px 0;"><button class="btn btn-ghost" id="loadOlderMessagesBtn">' +
      (messagesState.loadingOlder ? 'Loading...' : 'Load older messages') + '</button></div>'
    : '';

  listEl.innerHTML = loadMoreHtml + allMessages.map(function(message) {
    var mine = message.authorId === (state.user && state.user.uid);
    var author = escapeHTML(message.authorName || 'Member');
    var body = escapeHTML(message.body || '');
    var time = 'just now';
    var isLatestOwn = mine && message.id === lastOwnMessageId;
    var seen = isLatestOwn && peerReadAtMs > 0 && getFirestoreTimeMs(message.createdAt) <= peerReadAtMs;
    var statusHtml = isLatestOwn
      ? '<div class="message-bubble-status' + (seen ? ' seen' : '') + '">' + (seen ? 'Seen' : 'Sent') + '</div>'
      : '';

    if (message.createdAt && typeof message.createdAt.toDate === 'function') {
      time = relativeTime(message.createdAt.toDate());
    }

    return '' +
      '<div class="message-bubble-row' + (mine ? ' mine' : '') + '">' +
        '<div class="message-bubble">' +
          '<div class="message-bubble-meta">' + author + ' · ' + escapeHTML(time) + '</div>' +
          '<div class="message-bubble-body">' + body + '</div>' +
          statusHtml +
        '</div>' +
      '</div>';
  }).join('');

  // Wire load older button
  var olderBtn = document.getElementById('loadOlderMessagesBtn');
  if (olderBtn) {
    olderBtn.addEventListener('click', loadOlderMessages);
  }

  // Only auto-scroll to bottom if not loading older messages
  if (!messagesState.loadingOlder) {
    listEl.scrollTop = listEl.scrollHeight;
  }
};

var subscribeMessageThread = function(conversationId) {
  if (messagesState.unsubscribeThread) {
    messagesState.unsubscribeThread();
    messagesState.unsubscribeThread = null;
  }

  messagesState.activeConversationId = conversationId;
  messagesState.thread = [];
  messagesState.olderMessages = [];
  messagesState.hasMoreMessages = false;
  messagesState.loadingOlder = false;
  messagesState.oldestDoc = null;

  var MESSAGE_PAGE = 100;

  var q = query(
    collection(db, 'conversations', conversationId, 'messages'),
    orderBy('createdAt', 'desc'),
    limit(MESSAGE_PAGE)
  );

  messagesState.unsubscribeThread = onSnapshot(q, function(snap) {
    var thread = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      thread.push(data);
    });
    messagesState.hasMoreMessages = thread.length >= MESSAGE_PAGE;
    messagesState.oldestDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
    thread.reverse();
    messagesState.thread = thread;
    renderMessagesThread();
    markConversationRead(conversationId);
  }, function(err) {
    console.error('Failed to load thread:', err);
    var listEl = document.getElementById('messagesThreadList');
    if (listEl) {
      listEl.innerHTML = '<div class="messages-empty-state text-muted">Failed to load messages.</div>';
    }
  });
};

var loadOlderMessages = function() {
  if (messagesState.loadingOlder || !messagesState.hasMoreMessages || !messagesState.oldestDoc) return;
  messagesState.loadingOlder = true;

  var convId = messagesState.activeConversationId;
  var q = query(
    collection(db, 'conversations', convId, 'messages'),
    orderBy('createdAt', 'desc'),
    startAfter(messagesState.oldestDoc),
    limit(100)
  );

  getDocs(q).then(function(snap) {
    var older = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      older.push(data);
    });

    messagesState.hasMoreMessages = older.length >= 100;
    if (snap.docs.length > 0) {
      messagesState.oldestDoc = snap.docs[snap.docs.length - 1];
    }

    older.reverse();
    messagesState.olderMessages = older.concat(messagesState.olderMessages);
    renderMessagesThread();
  }).catch(function(err) {
    console.error('Load older messages error:', err);
    showToast('Failed to load older messages.', 'error');
  }).finally(function() {
    messagesState.loadingOlder = false;
  });
};

var openMessageThread = function(peerId) {
  messagesState.activePeerId = peerId;
  var conversation = findConversationForPeer(peerId);

  renderMessagesPeopleList();

  if (!conversation) {
    if (messagesState.unsubscribeThread) {
      messagesState.unsubscribeThread();
      messagesState.unsubscribeThread = null;
    }
    messagesState.activeConversationId = null;
    messagesState.thread = [];
    renderMessagesThread();
    return;
  }

  subscribeMessageThread(conversation.id);
  markConversationRead(conversation.id);
  renderMessagesThread();
};

var loadMessageMembers = function() {
  getDocs(collection(db, 'users')).then(function(snap) {
    var members = [];
    snap.forEach(function(d) {
      if (!state.user || d.id === state.user.uid) return;
      var data = d.data();
      data.uid = d.id;
      members.push(data);
    });

    members.sort(function(a, b) {
      return (a.name || a.email || '').localeCompare(b.name || b.email || '');
    });

    messagesState.members = members;

    if (messagesState.activePeerId && !findMessageMember(messagesState.activePeerId)) {
      messagesState.activePeerId = null;
      messagesState.activeConversationId = null;
      messagesState.thread = [];
    }

    if (!messagesState.activePeerId && members.length > 0) {
      var firstConversation = messagesState.conversations[0];
      messagesState.activePeerId = firstConversation
        ? getConversationPeerId(firstConversation)
        : members[0].uid;
    }

    renderMessagesPeopleList();
    renderMessagesThread();
  }).catch(function(err) {
    console.error('Failed to load message members:', err);
    var list = document.getElementById('messagesPeopleList');
    if (list) {
      list.innerHTML = '<div class="messages-empty-state text-muted">Failed to load members.</div>';
    }
  });
};

var subscribeConversations = function() {
  if (!state.user) return;

  if (messagesState.unsubscribeConversations) {
    messagesState.unsubscribeConversations();
    messagesState.unsubscribeConversations = null;
  }

  var q = query(
    collection(db, 'conversations'),
    where('members', 'array-contains', state.user.uid)
  );

  messagesState.unsubscribeConversations = onSnapshot(q, function(snap) {
    var conversations = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      conversations.push(data);
    });

    conversations.sort(function(a, b) {
      return getConversationSortValue(b) - getConversationSortValue(a);
    });

    messagesState.conversations = conversations;
    syncMessagesUnreadState();

    if (state.currentPage === 'messages' && messagesState.activePeerId) {
      var activeConversation = findConversationForPeer(messagesState.activePeerId);
      if (activeConversation) {
        if (messagesState.activeConversationId !== activeConversation.id) {
          subscribeMessageThread(activeConversation.id);
        }
        markConversationRead(activeConversation.id);
      } else {
        messagesState.activeConversationId = null;
        messagesState.thread = [];
      }
    } else if (state.currentPage === 'messages' && conversations.length > 0) {
      messagesState.activePeerId = getConversationPeerId(conversations[0]);
      subscribeMessageThread(conversations[0].id);
    }

    renderMessagesPeopleList();
    if (state.currentPage === 'messages') {
      renderMessagesThread();
    }
  }, function(err) {
    console.error('Failed to load conversations:', err);
    var list = document.getElementById('messagesPeopleList');
    if (list) {
      list.innerHTML = '<div class="messages-empty-state text-muted">Failed to load conversations.</div>';
    }
  });
};

var handleSendMessage = function() {
  if (!state.user || !messagesState.activePeerId) return;

  var input = document.getElementById('messagesComposeInput');
  var sendBtn = document.getElementById('messagesSendBtn');
  if (!input || !sendBtn) return;

  var body = input.value.trim();
  if (!body) return;

  var peer = findMessageMember(messagesState.activePeerId);
  if (!peer) return;

  var conversationId = getConversationId(state.user.uid, peer.uid);
  var conversationRef = doc(db, 'conversations', conversationId);
  var preview = body.length > 120 ? body.slice(0, 117) + '...' : body;
  var members = [state.user.uid, peer.uid].sort();

  input.disabled = true;
  sendBtn.disabled = true;

  runTransaction(db, function(tx) {
    return tx.get(conversationRef).then(function(snap) {
      var unreadCount = {};
      var readBy = {};

      if (snap.exists()) {
        var data = snap.data() || {};
        unreadCount = Object.assign({}, data.unreadCount || {});
        readBy = Object.assign({}, data.readBy || {});
      }

      unreadCount[state.user.uid] = 0;
      unreadCount[peer.uid] = (typeof unreadCount[peer.uid] === 'number' ? unreadCount[peer.uid] : 0) + 1;
      readBy[state.user.uid] = Timestamp.now();

      tx.set(conversationRef, {
        members: members,
        updatedAt: serverTimestamp(),
        lastMessage: preview,
        lastSenderId: state.user.uid,
        unreadCount: unreadCount,
        readBy: readBy
      }, { merge: true });
    });
  }).then(function() {
    return addDoc(collection(db, 'conversations', conversationId, 'messages'), {
      authorId: state.user.uid,
      authorName: state.user.displayName || state.user.email || 'Member',
      body: body,
      createdAt: serverTimestamp()
    });
  }).then(function() {
    messagesState.activePeerId = peer.uid;
    if (messagesState.activeConversationId !== conversationId) {
      subscribeMessageThread(conversationId);
    }
    markConversationRead(conversationId);
    input.value = '';
  }).catch(function(err) {
    console.error('Failed to send message:', err);
    showToast('Failed to send message. Check console for details.', 'error');
  }).finally(function() {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  });
};

var initMessagesPage = function() {
  var form = document.getElementById('messagesComposer');
  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      handleSendMessage();
    });
  }

  renderMessagesPeopleList();
  renderMessagesThread();
  loadMessageMembers();
};

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
    console.error('Failed to load allowlist:', err);
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

// ─── Members: render grid ────────────────────────────────────────────────────
var renderMembersList = function() {
  var list = document.getElementById('membersList');
  if (!list) return;

  if (membersState.members.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No members yet. As people sign in, they\'ll appear here.</p></div>';
    return;
  }

  list.innerHTML = membersState.members.map(renderMemberCard).join('');

  // Wire card clicks
  list.querySelectorAll('.member-card').forEach(function(card) {
    card.addEventListener('click', function() {
      openProfile(card.dataset.uid);
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
    console.error('Failed to save allowlist entry:', err);
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
      console.error('Failed to remove allowlist entry:', err);
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
          btn.hidden = getVisibleCircles().indexOf(btn.dataset.circle) === -1;
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

// ─── Members: render single card ─────────────────────────────────────────────
var renderMemberCard = function(m) {
  var nameEsc     = escapeHTML(m.name || 'Unknown');
  var initialsEsc = escapeHTML(m.initials || '?');
  var roleBio     = m.role || m.bio || '';
  var roleBioEsc  = escapeHTML(roleBio || '—');

  var avatarStyle = m.photoURL
    ? ' style="background-image:url(' + escapeAttr(m.photoURL) + ')"'
    : '';
  var avatarText = m.photoURL ? '' : initialsEsc;

  var circles = Array.isArray(m.circles) ? m.circles : [];
  var circleTags = circles.map(function(c) {
    return '<span class="circle-tag">' + escapeHTML(circleLabel(c)) + '</span>';
  }).join('');
  if (!circleTags) {
    circleTags = '<span class="circle-tag circle-tag-empty">No circles</span>';
  }

  return '' +
    '<div class="member-card" data-uid="' + escapeAttr(m.uid) + '">' +
      '<div class="member-avatar"' + avatarStyle + '>' + avatarText + '</div>' +
      '<div class="member-name">' + nameEsc + '</div>' +
      '<div class="member-role">' + roleBioEsc + '</div>' +
      '<div class="member-circles">' + circleTags + '</div>' +
    '</div>';
};

// ─── Members: profile modal open/close ──────────────────────────────────────
var openProfile = function(uid) {
  var member = membersState.members.find(function(m) { return m.uid === uid; });
  if (!member) return;

  var modal = document.getElementById('profileModal');
  var body  = document.getElementById('profileModalBody');
  if (!modal || !body) return;

  var nameEsc     = escapeHTML(member.name || 'Unknown');
  var initialsEsc = escapeHTML(member.initials || '?');
  var bioEsc      = escapeHTML(member.bio || 'No bio yet.');
  var roleEsc     = escapeHTML(member.role || 'Member');

  var avatarStyle = member.photoURL
    ? ' style="background-image:url(' + escapeAttr(member.photoURL) + ')"'
    : '';
  var avatarText = member.photoURL ? '' : initialsEsc;

  var circles = Array.isArray(member.circles) ? member.circles : [];
  var circleTags = circles.map(function(c) {
    return '<span class="circle-tag">' + escapeHTML(circleLabel(c)) + '</span>';
  }).join('');
  if (!circleTags) {
    circleTags = '<span class="text-muted">Not in any circles.</span>';
  }

  var isSelf = state.user && state.user.uid === uid;
  var editBtnHTML = isSelf
    ? '<button class="btn btn-primary profile-edit-btn" id="profileEditBtn">Edit Profile</button>'
    : '';

  body.innerHTML =
    '<div class="profile-header">' +
      '<div class="profile-avatar-lg"' + avatarStyle + '>' + avatarText + '</div>' +
      '<div class="profile-header-meta">' +
        '<h2 class="profile-name">' + nameEsc + '</h2>' +
        '<p class="text-muted">' + roleEsc + '</p>' +
      '</div>' +
      editBtnHTML +
    '</div>' +
    '<div class="profile-section">' +
      '<div class="profile-section-title">Bio</div>' +
      '<p>' + bioEsc + '</p>' +
    '</div>' +
    '<div class="profile-section">' +
      '<div class="profile-section-title">Circles</div>' +
      '<div class="member-circles">' + circleTags + '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<div class="profile-section-title">Recent Posts</div>' +
      '<div id="profilePosts"><p class="text-muted">Loading...</p></div>' +
    '</div>';

  if (isSelf) {
    var editBtn = document.getElementById('profileEditBtn');
    if (editBtn) {
      editBtn.addEventListener('click', function() {
        renderEditProfileForm(member);
      });
    }
  }

  modal.hidden = false;
  loadRecentPosts(uid);
};

// ─── Members: edit profile form ─────────────────────────────────────────────
var renderEditProfileForm = function(member) {
  var body = document.getElementById('profileModalBody');
  if (!body) return;

  var bioVal  = escapeAttr(member.bio  || '');
  var roleVal = escapeAttr(member.role || '');
  var currentCircles = Array.isArray(member.circles) ? member.circles : [];
  var canEditCircles = !!state.isAdmin;
  var circlesHTML = canEditCircles
    ? '<div class="circle-check-grid" id="editCircles">' + renderCircleChecks(currentCircles) + '</div>' +
      '<p class="text-muted mt-8">As an admin, you can update your own circle access here.</p>'
    : (function() {
        var circleTags = currentCircles.map(function(c) {
          return '<span class="circle-tag">' + escapeHTML(circleLabel(c)) + '</span>';
        }).join('');
        if (!circleTags) {
          circleTags = '<span class="circle-tag circle-tag-empty">No circles assigned</span>';
        }
        return '<div class="member-circles">' + circleTags + '</div>' +
          '<p class="text-muted mt-8">Ask an admin if you need circle access changed.</p>';
      })();

  body.innerHTML =
    '<div class="profile-header">' +
      '<div class="profile-header-meta">' +
        '<h2 class="profile-name">Edit Profile</h2>' +
        '<p class="text-muted">Update your bio and role.' + (canEditCircles ? ' You can also manage your circles.' : ' Circles are managed by admins.') + '</p>' +
      '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="editRole">Role</label>' +
      '<input type="text" id="editRole" class="edit-input" maxlength="60" placeholder="e.g. Founder, Developer" value="' + roleVal + '" />' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="editBio">Bio</label>' +
      '<textarea id="editBio" class="edit-input edit-textarea" rows="4" maxlength="280" placeholder="Tell the enclave about yourself...">' + bioVal + '</textarea>' +
    '</div>' +
    '<div class="profile-section">' +
      '<div class="profile-section-title">Circles</div>' +
      circlesHTML +
    '</div>' +
    '<div class="edit-actions">' +
      '<button class="btn" id="editCancelBtn">Cancel</button>' +
      '<button class="btn btn-primary" id="editSaveBtn">Save</button>' +
    '</div>';

  document.getElementById('editCancelBtn').addEventListener('click', function() {
    openProfile(member.uid);
  });
  document.getElementById('editSaveBtn').addEventListener('click', function() {
    handleSaveProfile(member.uid);
  });
};

// ─── Members: save profile edits ────────────────────────────────────────────
var handleSaveProfile = function(uid) {
  if (!state.user || state.user.uid !== uid) return;

  var roleEl = document.getElementById('editRole');
  var bioEl  = document.getElementById('editBio');
  var saveBtn = document.getElementById('editSaveBtn');
  if (!roleEl || !bioEl) return;

  var newRole = roleEl.value.trim();
  var newBio  = bioEl.value.trim();
  var newCircles = state.isAdmin
    ? getCheckedCircles('#editCircles')
    : null;

  if (saveBtn) {
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving...';
  }

  var ref = doc(db, 'users', uid);
  var updates = {
    role:    newRole,
    bio:     newBio
  };

  if (newCircles) {
    updates.circles = newCircles;
  }

  updateDoc(ref, updates).then(function() {
    // Update local cache so UI reflects change without a full reload
    var member = membersState.members.find(function(m) { return m.uid === uid; });
    if (member) {
      member.role    = newRole;
      member.bio     = newBio;
      if (newCircles) {
        member.circles = newCircles.slice();
      }
    }
    if (newCircles && state.user && state.user.uid === uid) {
      state.circles = newCircles.slice();
      loadPanelCircles();
    }
    renderMembersList();
    openProfile(uid);
  }).catch(function(err) {
    console.error('Failed to save profile:', err);
    showToast('Failed to save profile. Check console for details.', 'error');
    if (saveBtn) {
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Save';
    }
  });
};

var closeProfile = function() {
  var modal = document.getElementById('profileModal');
  if (modal) modal.hidden = true;
};

// ─── Members: recent posts for profile modal ────────────────────────────────
var loadRecentPosts = function(uid) {
  var container = document.getElementById('profilePosts');
  if (!container) return;

  var q = query(
    collection(db, 'posts'),
    where('authorId', '==', uid),
    where('circle', 'in', getVisibleCircles()),
    orderBy('timestamp', 'desc'),
    limit(5)
  );

  getDocs(q).then(function(snap) {
    var posts = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      posts.push(data);
    });

    if (posts.length === 0) {
      container.innerHTML = '<p class="text-muted">No posts yet.</p>';
      return;
    }

    container.innerHTML = posts.map(renderPostCard).join('');

    container.querySelectorAll('[data-share-post]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        handleSharePost(btn.dataset.sharePost);
      });
    });

    container.querySelectorAll('[data-toggle-comments-post]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        togglePostComments(btn.dataset.toggleCommentsPost, btn.dataset.postAuthor);
      });
    });

    container.querySelectorAll('[data-comment-form]').forEach(function(form) {
      form.addEventListener('submit', function(e) {
        e.preventDefault();
        handleCommentSubmit(form.dataset.commentForm, form.dataset.postAuthor, form);
      });
    });

    container.querySelectorAll('[data-react-post]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        handleReactPost(btn.dataset.reactPost);
      });
    });

    container.querySelectorAll('[data-delete-post]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        handleDeletePost(btn.dataset.deletePost, btn.dataset.postAuthor);
      });
    });
  }).catch(function(err) {
    console.error('Failed to load recent posts:', err);
    // If it's a missing-index error, Firestore returns a specific message
    var msg = err && err.message && err.message.indexOf('index') !== -1
      ? 'Posts query needs a Firestore index. Check browser console for a link to create it.'
      : 'Failed to load posts.';
    container.innerHTML = '<p class="text-muted">' + msg + '</p>';
  });
};

// ─── Events: init ────────────────────────────────────────────────────────────
var initEventsPage = function() {
  var composer = document.getElementById('eventAdminComposer');
  var createBtn = document.getElementById('createEventBtn');
  if (createBtn) {
    createBtn.hidden = true;
    createBtn.addEventListener('click', function() {
      window.enclaveCreateEvent();
    });
  }

  var modalCloseBtn = document.querySelector('#eventModal .profile-modal-close');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  var modalBackdrop = document.querySelector('#eventModal .profile-modal-backdrop');
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  // Always render the composer if user is signed in. Firestore rules enforce
  // admin-only writes — non-admins will get a clear permission error.
  if (composer) {
    composer.innerHTML = '';
  }

  if (state.isAdmin) {
    renderInlineEventComposer();
  }
  loadEvents();
};

// Globally-exposed functions for inline onclick handlers in page HTML.
window.enclaveCreateEvent = function() {
  if (!state.isAdmin) return;
  openCreateEventModal();
};

window.enclaveCloseEvent = function() {
  closeEventModal();
};

// ─── Events: load upcoming ───────────────────────────────────────────────────
var loadEvents = function() {
  var list = document.getElementById('eventsList');
  if (!list) return;

  var threshold = getUpcomingEventsThreshold();
  var upcomingQuery = query(
    collection(db, 'events'),
    where('circle', 'in', getVisibleCircles()),
    where('date', '>=', threshold),
    orderBy('date', 'asc')
  );
  var pastQuery = query(
    collection(db, 'events'),
    where('circle', 'in', getVisibleCircles()),
    where('date', '<', threshold),
    orderBy('date', 'asc')
  );

  Promise.all([getDocs(upcomingQuery), getDocs(pastQuery)]).then(function(results) {
    var upcoming = [];
    var past = [];

    results[0].forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      upcoming.push(data);
    });

    results[1].forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      past.push(data);
    });

    past.reverse();
    eventsState.upcoming = upcoming;
    eventsState.past = past;
    renderEventsList();
  }).catch(function(err) {
    console.error('Failed to load events:', err);
    list.innerHTML = '<div class="card"><p class="text-muted">Failed to load events. Check Firestore rules.</p></div>';
  });
};

var bindEventRsvpButtons = function(container) {
  if (!container) return;

  container.querySelectorAll('[data-rsvp]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleRsvp(btn.dataset.rsvp, btn);
    });
  });

  if (!state.user) return;

  eventsState.upcoming.forEach(function(ev) {
    var rsvpRef = doc(db, 'events', ev.id, 'rsvps', state.user.uid);
    getDoc(rsvpRef).then(function(snap) {
      if (!snap.exists()) return;

      var btn = container.querySelector('[data-rsvp="' + ev.id + '"]');
      if (!btn) return;

      btn.classList.add('rsvped');
      btn.textContent = rsvpButtonLabel(ev.rsvpCount, true);
    }).catch(function() { /* ignore */ });
  });
};

// ─── Events: render list ─────────────────────────────────────────────────────
var renderEventsList = function() {
  var list = document.getElementById('eventsList');
  if (!list) return;

  var hasUpcoming = eventsState.upcoming.length > 0;
  var hasPast = eventsState.past.length > 0;

  if (!hasUpcoming && !hasPast) {
    list.innerHTML = '<div class="card"><p class="text-muted">No events yet. ' +
      (state.isAdmin ? 'Create one to get the calendar started.' : 'Check back soon.') + '</p></div>';
    return;
  }

  var upcomingHtml = hasUpcoming
    ? eventsState.upcoming.map(function(ev) {
      return renderEventCard(ev, { isPast: false });
    }).join('')
    : '<div class="card"><p class="text-muted">No upcoming events right now.</p></div>';

  var pastHtml = hasPast
    ? eventsState.past.map(function(ev) {
      return renderEventCard(ev, { isPast: true });
    }).join('')
    : '<div class="card"><p class="text-muted">No past events yet.</p></div>';

  list.innerHTML =
    '<section class="events-section">' +
      '<div class="events-section-header">' +
        '<h2 class="events-section-title">Upcoming Events</h2>' +
        '<p class="text-muted">What is coming up next.</p>' +
      '</div>' +
      '<div class="events-list-stack" id="upcomingEventsList">' + upcomingHtml + '</div>' +
    '</section>' +
    '<section class="events-section">' +
      '<div class="events-section-header">' +
        '<h2 class="events-section-title">Past Events</h2>' +
        '<p class="text-muted">A simple archive of gatherings that already happened.</p>' +
      '</div>' +
      '<div class="events-list-stack" id="pastEventsList">' + pastHtml + '</div>' +
    '</section>';

  bindEventRsvpButtons(document.getElementById('upcomingEventsList'));
};

// ─── Events: render single card ──────────────────────────────────────────────
var renderEventCard = function(ev, opts) {
  opts = opts || {};
  var titleEsc    = escapeHTML(ev.title    || 'Untitled');
  var locationEsc = escapeHTML(ev.location || 'TBD');
  var circleLbl   = escapeHTML(circleLabel(ev.circle || 'all'));
  var descEsc     = escapeHTML(ev.description || '');

  var when = 'TBD';
  if (ev.date && typeof ev.date.toDate === 'function') {
    var d = ev.date.toDate();
    when = d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric'
    }) + ' · ' + d.toLocaleTimeString(undefined, {
      hour: 'numeric', minute: '2-digit'
    });
  }

  var rsvpCount = (typeof ev.rsvpCount === 'number') ? ev.rsvpCount : 0;
  var statusHtml = opts.isPast
    ? '<span class="event-status-label">Past Event</span>'
    : '';
  var actionsHtml = opts.isPast
    ? '<div class="event-actions event-actions-static"><span class="text-muted">RSVP closed</span></div>'
    : '<div class="event-actions">' +
        '<button class="btn btn-primary" data-rsvp="' + escapeAttr(ev.id) + '">' + rsvpButtonLabel(rsvpCount, false) + '</button>' +
      '</div>';

  return '' +
    '<div class="event-card' + (opts.isPast ? ' event-card-past' : '') + '">' +
      '<div class="event-card-header">' +
        '<div>' +
          '<div class="event-title">' + titleEsc + '</div>' +
          statusHtml +
        '</div>' +
        '<span class="post-circle">' + circleLbl + '</span>' +
      '</div>' +
      '<div class="event-meta">' +
        '<div class="event-meta-row">&#128197; ' + escapeHTML(when) + '</div>' +
        '<div class="event-meta-row">&#128205; ' + locationEsc + '</div>' +
      '</div>' +
      (descEsc ? '<div class="event-desc">' + descEsc + '</div>' : '') +
      actionsHtml +
    '</div>';
};

// ─── Events: RSVP toggle ─────────────────────────────────────────────────────
var handleRsvp = function(eventId, btn) {
  if (!state.user || !eventId) return;

  var eventRef = doc(db, 'events', eventId);
  var rsvpRef = doc(db, 'events', eventId, 'rsvps', state.user.uid);

  btn.disabled = true;

  runTransaction(db, function(transaction) {
    return transaction.get(eventRef).then(function(eventSnap) {
      if (!eventSnap.exists()) throw new Error('Event not found.');

      return transaction.get(rsvpRef).then(function(rsvpSnap) {
        var eventData = eventSnap.data() || {};
        var currentCount = typeof eventData.rsvpCount === 'number' ? eventData.rsvpCount : 0;

        if (rsvpSnap.exists()) {
          var nextCount = currentCount > 0 ? currentCount - 1 : 0;
          transaction.delete(rsvpRef);
          transaction.update(eventRef, { rsvpCount: nextCount });
          return {
            count:    nextCount,
            isRsvped: false
          };
        }

        var nextCount = currentCount + 1;
        transaction.set(rsvpRef, {
          uid:       state.user.uid,
          name:      state.user.displayName || state.user.email,
          email:     state.user.email,
          timestamp: serverTimestamp()
        });
        transaction.update(eventRef, { rsvpCount: nextCount });
        return {
          count:    nextCount,
          isRsvped: true
        };
      });
    });
  }).then(function(result) {
    setLocalEventRsvpCount(eventId, result.count);
    btn.classList.toggle('rsvped', result.isRsvped);
    btn.textContent = rsvpButtonLabel(result.count, result.isRsvped);
    btn.disabled = false;
  }).catch(function(err) {
    console.error('Failed to update RSVP:', err);
    showToast('Failed to update RSVP. Check console for details.', 'error');
    btn.disabled = false;
  });
};

// ─── Events: create event modal (admin only) ────────────────────────────────
var openCreateEventModal = function() {
  if (!state.isAdmin) return;
  var modal = document.getElementById('eventModal');
  var body  = document.getElementById('eventModalBody');
  if (!modal || !body) return;

  // Default to tomorrow 7pm
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var defaultDate = tomorrow.toISOString().slice(0, 10);

  body.innerHTML =
    '<div class="profile-header">' +
      '<div class="profile-header-meta">' +
        '<h2 class="profile-name">Create Event</h2>' +
        '<p class="text-muted">Add a new gathering to the enclave.</p>' +
      '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evTitle">Title</label>' +
      '<input type="text" id="evTitle" class="edit-input" maxlength="80" placeholder="e.g. Poker Night" />' +
    '</div>' +
    '<div class="profile-section event-date-row">' +
      '<div style="flex:1;">' +
        renderDatePickerField('evDate', 'Date', defaultDate) +
      '</div>' +
      '<div style="flex:1;">' +
        '<label class="profile-section-title" for="evTime">Time</label>' +
        '<select id="evTime" class="edit-input">' +
          renderTimeOptions('19:00') +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evLocation">Location</label>' +
      '<input type="text" id="evLocation" class="edit-input" maxlength="120" placeholder="e.g. Bob\'s place" />' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evCircle">Circle</label>' +
      '<select id="evCircle" class="edit-input">' +
        '<option value="all">All</option>' +
        '<option value="hustle-hub">Hustle Hub</option>' +
        '<option value="work-network">Work Network</option>' +
        '<option value="family">Family</option>' +
      '</select>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evDesc">Description</label>' +
      '<textarea id="evDesc" class="edit-input edit-textarea" rows="3" maxlength="400" placeholder="Optional details..."></textarea>' +
    '</div>' +
    '<div class="edit-actions">' +
      '<button class="btn" id="evCancelBtn">Cancel</button>' +
      '<button class="btn btn-primary" id="evSaveBtn">Create</button>' +
    '</div>';

  var cancelBtn = document.getElementById('evCancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  var saveBtn = document.getElementById('evSaveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      window.enclaveSubmitEvent();
    });
  }

  bindDatePickerField('evDate');

  modal.hidden = false;
};

// Expose for inline onclick handlers
window.enclaveSubmitEvent = function() { handleCreateEvent(); };

var closeEventModal = function() {
  var modal = document.getElementById('eventModal');
  if (modal) modal.hidden = true;
};

var handleCreateEvent = function() {
  if (!state.isAdmin || !state.user) return;

  var title    = document.getElementById('evTitle').value.trim();
  var dateVal  = document.getElementById('evDate').value;
  var timeVal  = document.getElementById('evTime').value;
  var location = document.getElementById('evLocation').value.trim();
  var circle   = document.getElementById('evCircle').value;
  var desc     = document.getElementById('evDesc').value.trim();

  if (!title)    { showToast('Title is required.', 'error');    return; }
  if (!dateVal)  { showToast('Date is required.', 'error');     return; }
  if (!timeVal)  { showToast('Time is required.', 'error');     return; }
  if (!location) { showToast('Location is required.', 'error'); return; }

  // Combine date + time into a JS Date, then Firestore Timestamp
  var combined = new Date(dateVal + 'T' + timeVal);
  if (isNaN(combined.getTime())) {
    showToast('Invalid date/time.', 'error');
    return;
  }

  var saveBtn = document.getElementById('evSaveBtn');
  if (saveBtn) {
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Creating...';
  }

  var newEvent = {
    title:       title,
    date:        Timestamp.fromDate(combined),
    location:    location,
    circle:      circle,
    description: desc,
    createdBy:   state.user.uid,
    createdAt:   serverTimestamp(),
    rsvpCount:   0
  };

  addDoc(collection(db, 'events'), newEvent).then(function() {
    closeEventModal();
    loadEvents();
  }).catch(function(err) {
    console.error('Failed to create event:', err);
    showToast('Failed to create event. Check console for details.', 'error');
    if (saveBtn) {
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Create';
    }
  });
};

var renderInlineEventComposer = function() {
  var composer = document.getElementById('eventAdminComposer');
  if (!composer) return;

  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var defaultDate = tomorrow.toISOString().slice(0, 10);

  composer.innerHTML =
    '<div class="card">' +
      '<div class="page-header-row">' +
        '<div>' +
          '<h2 class="profile-name">Create Event</h2>' +
          '<p class="text-muted">Add a new gathering to the enclave.</p>' +
        '</div>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvTitle">Title</label>' +
        '<input type="text" id="inlineEvTitle" class="edit-input" maxlength="80" placeholder="e.g. Poker Night" />' +
      '</div>' +
      '<div class="profile-section event-date-row">' +
        '<div style="flex:1;">' +
          renderDatePickerField('inlineEvDate', 'Date', defaultDate) +
        '</div>' +
      '<div style="flex:1;">' +
        '<label class="profile-section-title" for="inlineEvTime">Time</label>' +
        '<select id="inlineEvTime" class="edit-input">' +
          renderTimeOptions('19:00') +
        '</select>' +
      '</div>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvLocation">Location</label>' +
        '<input type="text" id="inlineEvLocation" class="edit-input" maxlength="120" placeholder="e.g. Bob\'s place" />' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvCircle">Circle</label>' +
        '<select id="inlineEvCircle" class="edit-input">' + renderCircleOptions(true) + '</select>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvDesc">Description</label>' +
        '<textarea id="inlineEvDesc" class="edit-input edit-textarea" rows="3" maxlength="400" placeholder="Optional details..."></textarea>' +
      '</div>' +
      '<div class="edit-actions">' +
        '<button type="button" class="btn btn-primary" id="inlineEvSaveBtn">Create Event</button>' +
      '</div>' +
    '</div>';

  // Direct onclick assignment — not addEventListener, not inline attribute.
  // This is the single most reliable handler wiring in the DOM.
  var btn = document.getElementById('inlineEvSaveBtn');
  if (btn) {
    btn.onclick = function() {
      btn.textContent = 'Working...';
      btn.disabled = true;
      setTimeout(function() {
        handleInlineCreateEvent();
      }, 0);
    };
  }

  bindDatePickerField('inlineEvDate');
};

window.enclaveInlineCreate = function() {
  handleInlineCreateEvent();
};

var handleInlineCreateEvent = function() {
  if (!state.user) {
    showToast('Not signed in.', 'error');
    return;
  }

  var titleEl    = document.getElementById('inlineEvTitle');
  var dateEl     = document.getElementById('inlineEvDate');
  var timeEl     = document.getElementById('inlineEvTime');
  var locationEl = document.getElementById('inlineEvLocation');
  var circleEl   = document.getElementById('inlineEvCircle');
  var descEl     = document.getElementById('inlineEvDesc');
  var saveBtn    = document.getElementById('inlineEvSaveBtn');

  if (!titleEl || !dateEl || !timeEl || !locationEl || !circleEl || !descEl) {
    showToast('Form elements missing. See console.', 'error');
    return;
  }

  var title    = titleEl.value.trim();
  var dateVal  = dateEl.value;
  var timeVal  = timeEl.value;
  var location = locationEl.value.trim();
  var circle   = circleEl.value;
  var desc     = descEl.value.trim();

  var resetBtn = function() {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
  };

  if (!title)    { showToast('Title is required.', 'error');    resetBtn(); return; }
  if (!dateVal)  { showToast('Date is required.', 'error');     resetBtn(); return; }
  if (!timeVal)  { showToast('Time is required.', 'error');     resetBtn(); return; }
  if (!location) { showToast('Location is required.', 'error'); resetBtn(); return; }

  var combined = new Date(dateVal + 'T' + timeVal);
  if (isNaN(combined.getTime())) {
    showToast('Invalid date/time.', 'error');
    resetBtn();
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating...';
  }

  addDoc(collection(db, 'events'), {
    title:       title,
    date:        Timestamp.fromDate(combined),
    location:    location,
    circle:      circle,
    description: desc,
    createdBy:   state.user.uid,
    createdAt:   serverTimestamp(),
    rsvpCount:   0
  }).then(function(ref) {
    loadPanelEvents();
    titleEl.value = '';
    locationEl.value = '';
    descEl.value = '';
    circleEl.value = 'all';
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
    loadEvents();
  }).catch(function(err) {
    console.error('Failed to create event:', err);
    var msg;
    if (err.code === 'permission-denied') {
      msg = 'PERMISSION DENIED.\n\n' +
        'Firestore rejected the write. Two things to check:\n\n' +
        '1. Firebase Console → Firestore → Rules: paste the full ruleset that includes the /events/{eventId} block (with the /rsvps/{uid} subcollection) and click Publish.\n\n' +
        '2. Firebase Console → Firestore → users → your uid doc: the "role" field must be exactly the string "admin" (lowercase).';
    } else {
      msg = 'Failed to create event.\n\n' + (err.code || '') + '\n' + (err.message || '');
    }
    showNoticeModal('Create event failed', msg);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
  });
};

// ─── Drive Picker ────────────────────────────────────────────────────────────
var PICKER_APP_ID = '834210326738';
var PICKER_API_KEY = 'AIzaSyBC8nqTgaqMp0R45dnKpA44u0S5C3nnbFE';
var pickerApiLoaded = false;

var driveTokenClient = null;

var openDrivePicker = function() {
  if (!state.user) {
    showToast('Sign in first.', 'error');
    return;
  }

  if (!window.google || !window.google.accounts) {
    showToast('Google Identity Services still loading. Try again.', 'error');
    return;
  }

  // If we already have a token, go straight to picker
  if (state.googleAccessToken) {
    loadAndShowPicker();
    return;
  }

  // Use GIS token client to get Drive access token on demand
  if (!driveTokenClient) {
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: '834210326738-mo90co5s9c6fogmb4kse67dkshmigt2l.apps.googleusercontent.com',
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: function(tokenResponse) {
        if (tokenResponse && tokenResponse.access_token) {
          state.googleAccessToken = tokenResponse.access_token;
          loadAndShowPicker();
        } else {
          showToast('Could not get Drive access.', 'error');
        }
      }
    });
  }

  driveTokenClient.requestAccessToken({ prompt: '' });
};

var loadAndShowPicker = function() {
  if (!window.gapi) {
    showToast('Google API still loading. Try again in a moment.', 'error');
    return;
  }

  if (pickerApiLoaded) {
    createPicker();
    return;
  }

  window.gapi.load('picker', function() {
    pickerApiLoaded = true;
    createPicker();
  });
};

var createPicker = function() {
  try {
    var docsView = new google.picker.DocsView()
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);

    var picker = new google.picker.PickerBuilder()
      .addView(docsView)
      .setOAuthToken(state.googleAccessToken)
      .setAppId(PICKER_APP_ID)
      .setCallback(handlePickerResult)
      .setTitle('Attach a file from Google Drive')
      .build();

    picker.setVisible(true);
  } catch (err) {
    console.error('Picker build error:', err);
    showToast('Failed to open Drive picker: ' + err.message, 'error');
  }
};

var handlePickerResult = function(data) {
  if (data.action === google.picker.Action.PICKED && data.docs && data.docs.length > 0) {
    var file = data.docs[0];

    // Resource context: fill resource form fields
    if (pickerContext === 'resource') {
      var rUrlInput = document.getElementById('resourceUrl');
      var rTitleInput = document.getElementById('resourceTitle');
      if (rUrlInput) rUrlInput.value = file.url || '';
      if (rTitleInput && !rTitleInput.value.trim()) rTitleInput.value = file.name || '';
      pickerContext = 'feed';
      return;
    }

    // Project context: attach file to project
    if (pickerContext === 'project' && pickerProjectId) {
      handleProjectFileAttach(pickerProjectId, {
        fileUrl:     file.url || '',
        fileName:    file.name || 'Attached file',
        iconUrl:     file.iconUrl || '',
        addedBy:     state.user.uid,
        addedByName: state.user.displayName || state.user.email || 'Member',
        addedAt:     Timestamp.now()
      });
      pickerContext = 'feed';
      pickerProjectId = null;
      return;
    }

    // Default: feed compose attachment
    driveAttachment.fileUrl  = file.url || '';
    driveAttachment.fileName = file.name || 'Attached file';
    driveAttachment.iconUrl  = file.iconUrl || '';
    renderDrivePreview();
  }

  // Reset picker context on cancel
  if (data.action === google.picker.Action.CANCEL) {
    pickerContext = 'feed';
    pickerProjectId = null;
  }
};

var renderDrivePreview = function() {
  var el = document.getElementById('driveAttachmentPreview');
  if (!el) return;

  if (!driveAttachment.fileUrl) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  var nameEsc = escapeHTML(driveAttachment.fileName);
  el.hidden = false;
  el.innerHTML =
    '<div class="drive-preview-file">' +
      (driveAttachment.iconUrl
        ? '<img src="' + escapeAttr(driveAttachment.iconUrl) + '" class="drive-preview-icon" alt="" />'
        : '<span class="drive-preview-icon-fallback">&#128196;</span>') +
      '<span class="drive-preview-name">' + nameEsc + '</span>' +
      '<button type="button" class="drive-preview-remove" title="Remove attachment">&times;</button>' +
    '</div>' +
    '<div class="drive-preview-reminder">' +
      '&#9888;&#65039; Before posting, set sharing in Google Drive:<br>' +
      '<strong>Open file → Share → General access → "Anyone with the link" → Viewer/Commenter/Editor</strong><br>' +
      'Choose <em>Viewer</em> for read-only, <em>Commenter</em> for feedback, or <em>Editor</em> for full collaboration.' +
    '</div>';

  // Wire remove button
  var removeBtn = el.querySelector('.drive-preview-remove');
  if (removeBtn) {
    removeBtn.onclick = function() {
      clearDriveAttachment();
    };
  }
};

var clearDriveAttachment = function() {
  driveAttachment.fileUrl  = '';
  driveAttachment.fileName = '';
  driveAttachment.iconUrl  = '';
  var el = document.getElementById('driveAttachmentPreview');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
var getCircleDefinitions = function() {
  return [
    { id: 'hustle-hub',   label: 'Hustle Hub' },
    { id: 'work-network', label: 'Work Network' },
    { id: 'family',       label: 'Family' }
  ];
};

var renderCircleOptions = function(includeAll) {
  var html = includeAll
    ? '<option value="all">All</option>'
    : '';

  return html + getCircleDefinitions().map(function(circle) {
    return '<option value="' + circle.id + '">' + escapeHTML(circle.label) + '</option>';
  }).join('');
};

var renderCirclePills = function() {
  return '<button class="pill active" data-filter="all">All</button>' +
    getCircleDefinitions().map(function(circle) {
      return '<button class="pill" data-filter="' + circle.id + '">' + escapeHTML(circle.label) + '</button>';
    }).join('');
};

var renderCircleChecks = function(selectedCircles) {
  var selected = normalizeCircles(selectedCircles);

  return getCircleDefinitions().map(function(circle) {
    var checked = selected.indexOf(circle.id) !== -1 ? ' checked' : '';
    return '' +
      '<label class="circle-check">' +
        '<input type="checkbox" value="' + circle.id + '"' + checked + ' />' +
        '<span>' + escapeHTML(circle.label) + '</span>' +
      '</label>';
  }).join('');
};

var normalizeCircles = function(circles) {
  if (!Array.isArray(circles)) return [];

  return circles.filter(function(circle, index) {
    return ALL_CIRCLES.indexOf(circle) !== -1 && circles.indexOf(circle) === index;
  });
};

var getCheckedCircles = function(containerSelector) {
  var selected = [];

  document.querySelectorAll(containerSelector + ' input[type="checkbox"]').forEach(function(cb) {
    if (cb.checked) selected.push(cb.value);
  });

  return normalizeCircles(selected);
};

var setCheckedCircles = function(containerSelector, circles) {
  var normalized = normalizeCircles(circles);

  document.querySelectorAll(containerSelector + ' input[type="checkbox"]').forEach(function(cb) {
    cb.checked = normalized.indexOf(cb.value) !== -1;
  });
};

var getInitials = function(name) {
  if (!name) return '?';
  var parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

var relativeTime = function(date) {
  var sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 5)      return 'just now';
  if (sec < 60)     return sec + 's ago';
  if (sec < 3600)   return Math.floor(sec / 60)    + 'm ago';
  if (sec < 86400)  return Math.floor(sec / 3600)  + 'h ago';
  if (sec < 604800) return Math.floor(sec / 86400) + 'd ago';
  return date.toLocaleDateString();
};

var circleLabel = function(id) {
  if (id === 'all') return 'All';

  var circle = getCircleDefinitions().find(function(item) {
    return item.id === id;
  });

  return circle ? circle.label : id;
};

var getVisibleCircles = function() {
  var circles = state.isAdmin
    ? ALL_CIRCLES.slice()
    : (Array.isArray(state.circles) ? state.circles.slice() : []);

  circles.unshift('all');

  return circles.filter(function(circle, index) {
    return circles.indexOf(circle) === index;
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
  var morePages = { events: true, members: true, resources: true, admin: true };
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

var rsvpButtonLabel = function(count, isRsvped) {
  var total = typeof count === 'number' ? count : 0;
  var countLabel = total > 0 ? ' (' + total + ')' : '';
  return (isRsvped ? 'Going' : 'RSVP') + countLabel;
};

var setLocalEventRsvpCount = function(eventId, count) {
  ['upcoming', 'past'].forEach(function(bucket) {
    eventsState[bucket] = eventsState[bucket].map(function(eventItem) {
      if (eventItem.id !== eventId) return eventItem;
      eventItem.rsvpCount = count;
      return eventItem;
    });
  });
};

// ─── Projects: sidebar loader ───────────────────────────────────────────────
var loadSidebarProjects = function() {
  if (projectsState.sidebarUnsubscribe) {
    projectsState.sidebarUnsubscribe();
  }
  if (!state.user) return;

  var q = query(
    collection(db, 'projects'),
    where('memberIds', 'array-contains', state.user.uid),
    limit(50)
  );

  projectsState.sidebarUnsubscribe = onSnapshot(q, function(snap) {
    var container = document.getElementById('sidebarProjectsList');
    if (!container) return;

    if (snap.empty) {
      container.innerHTML = '<span class="text-muted" style="padding:0 12px;font-size:13px;">No projects yet</span>';
      return;
    }

    var items = [];
    snap.forEach(function(d) {
      var p = d.data();
      p.id = d.id;
      items.push(p);
    });

    sortProjectsByUpdatedAt(items);

    var html = '';
    items.slice(0, 10).forEach(function(p) {
      html += '<a class="sidebar-link sidebar-sublink" data-project="' + p.id + '" href="?page=projects&projectId=' + p.id + '">' +
        escapeHTML(p.name || 'Untitled') + '</a>';
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-project]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        projectsState.activeProjectId = btn.dataset.project;
        loadPage('projects');
      });
    });

    syncSidebarSelection();
  }, function(err) {
    console.error('Sidebar projects error:', err);
    var container = document.getElementById('sidebarProjectsList');
    if (container) {
      container.innerHTML = '<span class="text-muted" style="padding:0 12px;font-size:13px;">Projects unavailable</span>';
    }
  });
};

// ─── Projects: page init ────────────────────────────────────────────────────
var initProjectsPage = function() {
  var createBtn = document.getElementById('createProjectBtn');
  if (createBtn) {
    createBtn.onclick = function() {
      projectsState.editingProjectId = null;
      openProjectModal();
    };
  }

  var saveBtn = document.getElementById('projectModalSave');
  if (saveBtn) saveBtn.onclick = handleSaveProject;

  // Open modal if triggered from sidebar "new project" link
  if (projectsState.openModalOnLoad) {
    projectsState.openModalOnLoad = false;
    openProjectModal();
  }

  if (projectsState.activeProjectId) {
    loadProjectDetail(projectsState.activeProjectId);
    return;
  }

  subscribeProjectsList();
};

// ─── Projects: list subscription ────────────────────────────────────────────
var subscribeProjectsList = function() {
  if (!state.user) return;

  var q = query(
    collection(db, 'projects'),
    where('memberIds', 'array-contains', state.user.uid),
    limit(50)
  );

  projectsState.unsubscribe = onSnapshot(q, function(snap) {
    projectsState.projects = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      projectsState.projects.push(data);
    });
    sortProjectsByUpdatedAt(projectsState.projects);
    renderProjectsList();
  }, function(err) {
    console.error('Projects list error:', err);
    var list = document.getElementById('projectsList');
    if (list) {
      list.innerHTML = '<div class="card"><p class="text-muted">Failed to load projects.</p></div>';
    }
  });
};

// ─── Projects: render list ──────────────────────────────────────────────────
var renderProjectsList = function() {
  var list = document.getElementById('projectsList');
  if (!list) return;

  if (projectsState.projects.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No projects yet. Create one to get started.</p></div>';
    return;
  }

  list.innerHTML = projectsState.projects.map(function(p) {
    var statusClass = 'project-status project-status-' + (p.status || 'active').replace(/\s/g, '-');
    var memberCount = Array.isArray(p.memberIds) ? p.memberIds.length : 0;
    var desc = escapeHTML((p.description || '').substring(0, 120));
    return '' +
      '<div class="project-card" data-project-card="' + escapeAttr(p.id) + '">' +
        '<div class="project-card-name">' + escapeHTML(p.name || 'Untitled') + '</div>' +
        (desc ? '<div class="project-card-desc">' + desc + '</div>' : '') +
        '<div class="project-card-footer">' +
          '<span class="' + statusClass + '">' + escapeHTML(p.status || 'active') + '</span>' +
          '<span>' + memberCount + ' member' + (memberCount !== 1 ? 's' : '') + '</span>' +
          '<span class="project-card-tasks" data-task-count-for="' + escapeAttr(p.id) + '"></span>' +
        '</div>' +
      '</div>';
  }).join('');

  // Fetch task counts per project and render mini progress
  projectsState.projects.forEach(function(p) {
    getDocs(query(collection(db, 'projects', p.id, 'tasks'))).then(function(snap) {
      var total = snap.size;
      var done = 0;
      snap.forEach(function(d) { if (d.data().status === 'done') done++; });
      var el = document.querySelector('[data-task-count-for="' + p.id + '"]');
      if (el && total > 0) {
        var pct = Math.round((done / total) * 100);
        el.innerHTML = '<span class="project-card-tasks-label">' + done + '/' + total + ' tasks</span>' +
          '<div class="project-card-progress"><div class="project-card-progress-fill" style="width:' + pct + '%"></div></div>';
      }
    }).catch(function() {});
  });

  list.querySelectorAll('[data-project-card]').forEach(function(card) {
    card.addEventListener('click', function() {
      projectsState.activeProjectId = card.dataset.projectCard;
      syncURLState();
      loadProjectDetail(card.dataset.projectCard);
    });
  });
};

var getFirestoreTimeMs = function(value) {
  if (value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  var parsed = new Date(value || 0).getTime();
  return isNaN(parsed) ? 0 : parsed;
};

var getProjectCommentsForRender = function(p) {
  return projectsState.activeProjectId === p.id
    ? projectsState.detailComments.slice()
    : [];
};

var getProjectFilesForRender = function(p) {
  return projectsState.activeProjectId === p.id
    ? projectsState.detailFiles.slice()
    : [];
};

var getProjectTasksForRender = function(p) {
  return projectsState.activeProjectId === p.id
    ? projectsState.detailTasks.slice()
    : [];
};

var sortProjectsByUpdatedAt = function(items) {
  return items.sort(function(a, b) {
    return getFirestoreTimeMs(b.updatedAt || b.createdAt) - getFirestoreTimeMs(a.updatedAt || a.createdAt);
  });
};

var refreshProjectDetailView = function() {
  // Don't re-render if user is editing a task inline
  var detailEl = document.getElementById('projectDetail');
  if (detailEl && detailEl.querySelector('.task-edit-form')) return;
  if (projectsState.detailProject) {
    renderProjectDetail(projectsState.detailProject);
  }
};

var subscribeProjectCollections = function(projectId) {
  if (projectsState.commentsUnsubscribe) {
    projectsState.commentsUnsubscribe();
    projectsState.commentsUnsubscribe = null;
  }

  if (projectsState.filesUnsubscribe) {
    projectsState.filesUnsubscribe();
    projectsState.filesUnsubscribe = null;
  }

  if (projectsState.tasksUnsubscribe) {
    projectsState.tasksUnsubscribe();
    projectsState.tasksUnsubscribe = null;
  }

  projectsState.detailComments = [];
  projectsState.detailFiles = [];
  projectsState.detailTasks = [];

  projectsState.commentsUnsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'comments'), orderBy('createdAt', 'asc')),
    function(snap) {
      projectsState.detailComments = [];
      snap.forEach(function(d) {
        var data = d.data();
        data.id = d.id;
        projectsState.detailComments.push(data);
      });
      refreshProjectDetailView();
    },
    function(err) {
      console.error('Project comments error:', err);
    }
  );

  projectsState.filesUnsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'files'), orderBy('addedAt', 'desc')),
    function(snap) {
      projectsState.detailFiles = [];
      snap.forEach(function(d) {
        var data = d.data();
        data.id = d.id;
        projectsState.detailFiles.push(data);
      });
      refreshProjectDetailView();
    },
    function(err) {
      console.error('Project files error:', err);
    }
  );

  projectsState.tasksUnsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'tasks'), orderBy('createdAt', 'asc')),
    function(snap) {
      projectsState.detailTasks = [];
      snap.forEach(function(d) {
        var data = d.data();
        data.id = d.id;
        projectsState.detailTasks.push(data);
      });
      refreshProjectDetailView();
    },
    function(err) {
      console.error('Project tasks error:', err);
    }
  );

  if (projectsState.activityUnsubscribe) {
    projectsState.activityUnsubscribe();
    projectsState.activityUnsubscribe = null;
  }
  projectsState.detailActivity = [];

  projectsState.activityUnsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'activity'), orderBy('createdAt', 'desc'), limit(30)),
    function(snap) {
      projectsState.detailActivity = [];
      snap.forEach(function(d) {
        var data = d.data();
        data.id = d.id;
        projectsState.detailActivity.push(data);
      });
      refreshProjectDetailView();
    },
    function(err) {
      console.error('Project activity error:', err);
    }
  );
};

// ─── Projects: detail view ──────────────────────────────────────────────────
var loadProjectDetail = function(projectId) {
  var listEl = document.getElementById('projectsList');
  var headerEl = document.querySelector('.page-header-row');
  var detailEl = document.getElementById('projectDetail');
  if (listEl) listEl.hidden = true;
  if (headerEl) headerEl.hidden = true;
  if (detailEl) {
    detailEl.hidden = false;
    detailEl.innerHTML = '<div class="feed-loading text-muted">Loading project...</div>';
  }

  resetProjectDetailState();
  subscribeProjectCollections(projectId);

  projectsState.detailUnsubscribe = onSnapshot(doc(db, 'projects', projectId), function(snap) {
    if (!snap.exists()) {
      if (detailEl) detailEl.innerHTML = '<div class="card"><p class="text-muted">Project not found.</p></div>';
      return;
    }
    var p = snap.data();
    p.id = snap.id;
    projectsState.detailProject = p;
    renderProjectDetail(p);
  }, function(err) {
    console.error('Project detail error:', err);
    if (detailEl) detailEl.innerHTML = '<div class="card"><p class="text-muted">Failed to load project.</p></div>';
  });
};

var renderProjectDetail = function(p) {
  var detailEl = document.getElementById('projectDetail');
  if (!detailEl) return;

  var statusClass = 'project-status project-status-' + (p.status || 'active').replace(/\s/g, '-');
  var canEdit = state.user && (state.isAdmin || p.createdBy === state.user.uid);
  var canDelete = canEdit;

  // Members
  var memberNames = p.memberNames || {};
  var memberIds = Array.isArray(p.memberIds) ? p.memberIds : [];
  var membersHtml = memberIds.map(function(uid) {
    var name = memberNames[uid] || 'Member';
    var initials = getInitials(name);
    return '<div class="project-member-chip">' +
      '<div class="project-member-avatar">' + escapeHTML(initials) + '</div>' +
      '<span>' + escapeHTML(name) + '</span>' +
    '</div>';
  }).join('');

  // Tasks
  var allTasks = getProjectTasksForRender(p);
  var openTasks = allTasks.filter(function(t) { return t.status !== 'done'; });
  var doneTasks = allTasks.filter(function(t) { return t.status === 'done'; });
  var totalTasks = allTasks.length;
  var doneCount = doneTasks.length;
  var progressPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

  // Apply task filter
  var now = new Date();
  now.setHours(0, 0, 0, 0);
  var filteredTasks = allTasks;
  var tf = projectsState.taskFilter || 'all';
  if (tf === 'mine') {
    filteredTasks = allTasks.filter(function(t) { return state.user && t.assigneeId === state.user.uid; });
  } else if (tf === 'overdue') {
    filteredTasks = allTasks.filter(function(t) {
      if (t.status === 'done' || !t.dueDate) return false;
      return new Date(t.dueDate + 'T00:00:00') < now;
    });
  }
  var filteredOpen = filteredTasks.filter(function(t) { return t.status !== 'done'; });
  var filteredDone = filteredTasks.filter(function(t) { return t.status === 'done'; });
  var sortedTasks = filteredOpen.concat(filteredDone);

  // Overdue count for filter badge
  var overdueCount = allTasks.filter(function(t) {
    if (t.status === 'done' || !t.dueDate) return false;
    return new Date(t.dueDate + 'T00:00:00') < now;
  }).length;
  var myTaskCount = allTasks.filter(function(t) { return state.user && t.assigneeId === state.user.uid; }).length;

  // Progress bar
  var progressHtml = totalTasks > 0
    ? '<div class="task-progress">' +
        '<div class="task-progress-bar"><div class="task-progress-fill" style="width:' + progressPct + '%"></div></div>' +
        '<span class="task-progress-label">' + doneCount + '/' + totalTasks + ' done (' + progressPct + '%)</span>' +
      '</div>'
    : '';

  // Filter pills
  var filterHtml = totalTasks > 0
    ? '<div class="task-filters">' +
        '<button class="task-filter-pill' + (tf === 'all' ? ' active' : '') + '" data-task-filter="all">All (' + totalTasks + ')</button>' +
        '<button class="task-filter-pill' + (tf === 'mine' ? ' active' : '') + '" data-task-filter="mine">My Tasks (' + myTaskCount + ')</button>' +
        '<button class="task-filter-pill' + (tf === 'overdue' ? ' active' : '') + '" data-task-filter="overdue">Overdue' + (overdueCount > 0 ? ' (' + overdueCount + ')' : '') + '</button>' +
      '</div>'
    : '';

  var tasksHtml = sortedTasks.length === 0
    ? '<p class="text-muted" style="font-size:13px;">' + (totalTasks === 0 ? 'No tasks yet. Add one to get started.' : 'No tasks match this filter.') + '</p>'
    : sortedTasks.map(function(t) {
        var assigneeName = t.assigneeName || 'Unassigned';
        var statusCls = 'task-status task-status-' + (t.status || 'todo');
        var statusLabel = t.status === 'doing' ? 'Doing' : t.status === 'done' ? 'Done' : 'To Do';
        var dueDateHtml = '';
        if (t.dueDate) {
          var now = new Date();
          now.setHours(0, 0, 0, 0);
          var due = new Date(t.dueDate + 'T00:00:00');
          var diffDays = Math.round((due - now) / 86400000);
          var dueCls = 'task-due';
          if (t.status !== 'done') {
            if (diffDays < 0) dueCls += ' task-overdue';
            else if (diffDays === 0) dueCls += ' task-due-today';
          }
          dueDateHtml = '<span class="' + dueCls + '">' + escapeHTML(t.dueDate) + '</span>';
        }
        var isDone = t.status === 'done';
        var canEditTask = state.isAdmin || (state.user && t.createdBy === state.user.uid);
        return '<div class="task-row' + (isDone ? ' task-done' : '') + '" data-task-id="' + escapeAttr(t.id) + '">' +
          '<button class="task-status-btn ' + statusCls + '" data-task-cycle="' + escapeAttr(t.id) + '" title="Cycle status">' + statusLabel + '</button>' +
          '<div class="task-info">' +
            '<span class="task-title">' + escapeHTML(t.title || 'Untitled') + '</span>' +
            '<span class="task-assignee">' + escapeHTML(assigneeName) + '</span>' +
          '</div>' +
          dueDateHtml +
          (canEditTask ? '<button class="task-edit-btn" data-task-edit="' + escapeAttr(t.id) + '" title="Edit task">&#9998;</button>' : '') +
          (canEditTask ? '<button class="task-delete-btn" data-task-delete="' + escapeAttr(t.id) + '" title="Delete task">&times;</button>' : '') +
        '</div>';
      }).join('');

  // Files
  var files = getProjectFilesForRender(p);
  var filesHtml = files.length === 0
    ? '<p class="text-muted" style="font-size:13px;">No files attached yet.</p>'
    : files.map(function(f, idx) {
        return '<div class="project-file-row">' +
          (f.iconUrl ? '<img src="' + escapeAttr(f.iconUrl) + '" width="18" height="18" alt="" />' : '&#128196;') +
          '<a href="' + escapeAttr(f.fileUrl) + '" target="_blank" rel="noopener">' + escapeHTML(f.fileName || 'File') + '</a>' +
          '<span class="project-file-meta">by ' + escapeHTML(f.addedByName || 'Member') + '</span>' +
        '</div>';
      }).join('');

  // Comments / discussion
  var comments = getProjectCommentsForRender(p);
  var commentsHtml = comments.map(function(c) {
    var cTime = (c.createdAt && typeof c.createdAt.toDate === 'function')
      ? relativeTime(c.createdAt.toDate())
      : 'just now';
    return '<div class="project-comment">' +
      '<div class="project-comment-avatar">' + escapeHTML(getInitials(c.authorName || '?')) + '</div>' +
      '<div class="project-comment-body">' +
        '<span class="project-comment-author">' + escapeHTML(c.authorName || 'Member') + '</span>' +
        '<span class="project-comment-time">' + cTime + '</span>' +
        '<div class="project-comment-text">' + highlightMentions(linkifyText(escapeHTML(c.body || ''))) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  detailEl.innerHTML = '' +
    '<div class="project-detail-header">' +
      '<button class="project-detail-back" id="projectBackBtn">&larr; Back to Projects</button>' +
      '<div class="project-detail-title">' + escapeHTML(p.name || 'Untitled') + '</div>' +
      '<span class="' + statusClass + '">' + escapeHTML(p.status || 'active') + '</span>' +
      (p.description ? '<div class="project-detail-desc">' + escapeHTML(p.description) + '</div>' : '') +
      (canEdit ? '<div class="project-detail-actions">' +
        '<button class="btn btn-ghost" id="projectEditBtn">Edit</button>' +
        (canDelete ? '<button class="btn btn-ghost post-action-danger" id="projectDeleteBtn">Delete</button>' : '') +
      '</div>' : '') +
    '</div>' +

    '<div class="project-detail-section">' +
      '<h3>Tasks <span class="task-count">' + openTasks.length + ' open</span></h3>' +
      progressHtml +
      filterHtml +
      '<div class="project-tasks-list">' + tasksHtml + '</div>' +
      '<form class="task-add-form" id="taskAddForm">' +
        '<input type="text" class="form-input" id="taskTitleInput" placeholder="Task title..." maxlength="200" />' +
        '<select class="form-input task-add-assignee" id="taskAssigneeInput">' +
          '<option value="">Unassigned</option>' +
          memberIds.map(function(uid) {
            return '<option value="' + escapeAttr(uid) + '">' + escapeHTML(memberNames[uid] || 'Member') + '</option>';
          }).join('') +
        '</select>' +
        '<input type="date" class="form-input task-add-date" id="taskDueDateInput" />' +
        '<button class="btn btn-primary" type="submit">Add</button>' +
      '</form>' +
    '</div>' +

    '<div class="project-detail-section">' +
      '<h3>Members</h3>' +
      '<div class="project-members-list">' + membersHtml + '</div>' +
    '</div>' +

    '<div class="project-detail-section">' +
      '<h3>Files</h3>' +
      '<div class="project-files-list">' + filesHtml + '</div>' +
      '<button class="btn btn-ghost" id="projectAttachFileBtn" style="margin-top:8px;">&#128193; Attach from Drive</button>' +
    '</div>' +

    '<div class="project-detail-section project-activity-section">' +
      '<h3>Activity</h3>' +
      '<div class="project-activity-log">' +
        (projectsState.detailActivity.length === 0
          ? '<p class="text-muted" style="font-size:13px;">No activity yet.</p>'
          : projectsState.detailActivity.map(function(a) {
              var aTime = (a.createdAt && typeof a.createdAt.toDate === 'function')
                ? relativeTime(a.createdAt.toDate())
                : 'just now';
              var icon = a.action === 'status' ? '&#9654;' : a.action === 'created' ? '&#43;' : '&#9998;';
              return '<div class="activity-entry">' +
                '<span class="activity-icon">' + icon + '</span>' +
                '<span class="activity-text"><strong>' + escapeHTML(a.authorName || 'Member') + '</strong> ' + escapeHTML(a.detail || a.action || '') + '</span>' +
                '<span class="activity-time">' + escapeHTML(aTime) + '</span>' +
              '</div>';
            }).join('')) +
      '</div>' +
    '</div>' +

    '<div class="project-detail-section">' +
      '<h3>Discussion</h3>' +
      '<div class="project-discussion">' + commentsHtml + '</div>' +
      '<form class="project-comment-compose" id="projectCommentForm">' +
        '<input type="text" maxlength="500" placeholder="Write a comment..." id="projectCommentInput" />' +
        '<button class="btn btn-primary" type="submit">Send</button>' +
      '</form>' +
    '</div>';

  // Wire back button
  var backBtn = document.getElementById('projectBackBtn');
  if (backBtn) backBtn.onclick = function() {
    projectsState.activeProjectId = null;
    resetProjectDetailState();
    var listEl = document.getElementById('projectsList');
    var headerEl = document.querySelector('.page-header-row');
    var detailEl2 = document.getElementById('projectDetail');
    if (listEl) listEl.hidden = false;
    if (headerEl) headerEl.hidden = false;
    if (detailEl2) { detailEl2.hidden = true; detailEl2.innerHTML = ''; }
    syncURLState();
    if (projectsState.unsubscribe) {
      projectsState.unsubscribe();
      projectsState.unsubscribe = null;
    }
    subscribeProjectsList();
  };

  // Wire edit
  var editBtn = document.getElementById('projectEditBtn');
  if (editBtn) editBtn.onclick = function() {
    projectsState.editingProjectId = p.id;
    openProjectModal(p);
  };

  // Wire delete
  var deleteBtn = document.getElementById('projectDeleteBtn');
  if (deleteBtn) deleteBtn.onclick = function() {
    showConfirmModal('Delete project', 'Delete this project? This cannot be undone.', 'Delete').then(function(ok) {
      if (!ok) return;
      // Clean up subcollections before deleting project doc
      var projectRef = doc(db, 'projects', p.id);
      var commentsCol = collection(db, 'projects', p.id, 'comments');
      var filesCol = collection(db, 'projects', p.id, 'files');
      var tasksCol = collection(db, 'projects', p.id, 'tasks');
      var activityCol = collection(db, 'projects', p.id, 'activity');
      Promise.all([getDocs(commentsCol), getDocs(filesCol), getDocs(tasksCol), getDocs(activityCol)]).then(function(results) {
        var deletes = [];
        results.forEach(function(snap) {
          snap.forEach(function(d) { deletes.push(deleteDoc(d.ref)); });
        });
        return Promise.all(deletes);
      }).then(function() {
        return deleteDoc(projectRef);
      }).then(function() {
        showToast('Project deleted.', 'info');
        projectsState.activeProjectId = null;
        loadPage('projects');
      }).catch(function(err) {
        console.error('Delete project error:', err);
        showToast('Failed to delete project.', 'error');
      });
    });
  };

  // Wire file attach
  var attachBtn = document.getElementById('projectAttachFileBtn');
  if (attachBtn) attachBtn.onclick = function() {
    pickerContext = 'project';
    pickerProjectId = p.id;
    openDrivePicker();
  };

  // Wire comment form
  var commentForm = document.getElementById('projectCommentForm');
  if (commentForm) commentForm.onsubmit = function(e) {
    e.preventDefault();
    var input = document.getElementById('projectCommentInput');
    var body = (input ? input.value : '').trim();
    if (!body) return;
    handleProjectComment(p.id, body);
    if (input) input.value = '';
  };

  // Wire @mention autocomplete on comment input
  var commentInput = document.getElementById('projectCommentInput');
  if (commentInput) {
    var mentionDropdown = null;
    commentInput.addEventListener('input', function() {
      var val = commentInput.value;
      var cursorPos = commentInput.selectionStart;
      var textBeforeCursor = val.substring(0, cursorPos);
      var atMatch = textBeforeCursor.match(/@(\w*)$/);

      if (mentionDropdown) { mentionDropdown.remove(); mentionDropdown = null; }

      if (!atMatch) return;
      var search = atMatch[1].toLowerCase();
      var matches = memberIds.filter(function(uid) {
        var name = (memberNames[uid] || '').toLowerCase();
        return name.indexOf(search) !== -1;
      });
      if (matches.length === 0) return;

      mentionDropdown = document.createElement('div');
      mentionDropdown.className = 'mention-dropdown';
      matches.forEach(function(uid) {
        var option = document.createElement('div');
        option.className = 'mention-option';
        option.textContent = memberNames[uid] || 'Member';
        option.onclick = function() {
          var before = val.substring(0, cursorPos - atMatch[0].length);
          var after = val.substring(cursorPos);
          var name = memberNames[uid] || 'Member';
          commentInput.value = before + '@' + name + ' ' + after;
          commentInput.focus();
          var newPos = before.length + name.length + 2;
          commentInput.setSelectionRange(newPos, newPos);
          if (mentionDropdown) { mentionDropdown.remove(); mentionDropdown = null; }
        };
        mentionDropdown.appendChild(option);
      });
      commentForm.style.position = 'relative';
      commentForm.appendChild(mentionDropdown);
    });

    commentInput.addEventListener('blur', function() {
      setTimeout(function() {
        if (mentionDropdown) { mentionDropdown.remove(); mentionDropdown = null; }
      }, 200);
    });
  }

  // Wire task add form
  var taskForm = document.getElementById('taskAddForm');
  if (taskForm) taskForm.onsubmit = function(e) {
    e.preventDefault();
    var titleInput = document.getElementById('taskTitleInput');
    var assigneeInput = document.getElementById('taskAssigneeInput');
    var dueDateInput = document.getElementById('taskDueDateInput');
    var title = (titleInput ? titleInput.value : '').trim();
    if (!title) return;
    var assigneeId = assigneeInput ? assigneeInput.value : '';
    var assigneeName = '';
    if (assigneeId && assigneeInput) {
      var sel = assigneeInput.options[assigneeInput.selectedIndex];
      assigneeName = sel ? sel.textContent : '';
    }
    handleAddTask(p.id, {
      title: title,
      assigneeId: assigneeId,
      assigneeName: assigneeName,
      dueDate: dueDateInput ? dueDateInput.value : ''
    });
    if (titleInput) titleInput.value = '';
    if (assigneeInput) assigneeInput.value = '';
    if (dueDateInput) dueDateInput.value = '';
  };

  // Wire task status cycling
  document.querySelectorAll('[data-task-cycle]').forEach(function(btn) {
    btn.onclick = function() {
      var taskId = btn.dataset.taskCycle;
      var task = projectsState.detailTasks.find(function(t) { return t.id === taskId; });
      if (!task) return;
      var nextStatus = task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : 'todo';
      updateDoc(doc(db, 'projects', p.id, 'tasks', taskId), {
        status: nextStatus
      }).then(function() {
        var statusLabels = { todo: 'To Do', doing: 'Doing', done: 'Done' };
        logProjectActivity(p.id, 'status', 'moved "' + (task.title || 'Untitled') + '" to ' + statusLabels[nextStatus]);
      }).catch(function(err) {
        console.error('Task status update error:', err);
        showToast('Failed to update task.', 'error');
      });
    };
  });

  // Wire task delete
  document.querySelectorAll('[data-task-delete]').forEach(function(btn) {
    btn.onclick = function() {
      var taskId = btn.dataset.taskDelete;
      showConfirmModal('Delete task', 'Delete this task?', 'Delete').then(function(ok) {
        if (!ok) return;
        deleteDoc(doc(db, 'projects', p.id, 'tasks', taskId)).catch(function(err) {
          console.error('Delete task error:', err);
          showToast('Failed to delete task.', 'error');
        });
      });
    };
  });

  // Wire task inline edit
  document.querySelectorAll('[data-task-edit]').forEach(function(btn) {
    btn.onclick = function() {
      var taskId = btn.dataset.taskEdit;
      var task = projectsState.detailTasks.find(function(t) { return t.id === taskId; });
      if (!task) return;
      var row = document.querySelector('[data-task-id="' + taskId + '"]');
      if (!row || row.querySelector('.task-edit-form')) return;

      var assigneeOptions = '<option value="">Unassigned</option>' +
        memberIds.map(function(uid) {
          var sel = uid === task.assigneeId ? ' selected' : '';
          return '<option value="' + escapeAttr(uid) + '"' + sel + '>' + escapeHTML(memberNames[uid] || 'Member') + '</option>';
        }).join('');

      row.innerHTML = '' +
        '<form class="task-edit-form" data-task-save="' + escapeAttr(taskId) + '">' +
          '<input type="text" class="form-input" value="' + escapeAttr(task.title || '') + '" data-edit-title maxlength="200" />' +
          '<select class="form-input task-add-assignee" data-edit-assignee>' + assigneeOptions + '</select>' +
          '<input type="date" class="form-input task-add-date" value="' + escapeAttr(task.dueDate || '') + '" data-edit-due />' +
          '<button class="btn btn-primary" type="submit">Save</button>' +
          '<button class="btn btn-ghost" type="button" data-edit-cancel>Cancel</button>' +
        '</form>';

      var form = row.querySelector('form');
      form.querySelector('[data-edit-title]').focus();

      form.onsubmit = function(e) {
        e.preventDefault();
        var newTitle = form.querySelector('[data-edit-title]').value.trim();
        if (!newTitle) return;
        var assigneeSelect = form.querySelector('[data-edit-assignee]');
        var newAssigneeId = assigneeSelect.value;
        var newAssigneeName = '';
        if (newAssigneeId) {
          var opt = assigneeSelect.options[assigneeSelect.selectedIndex];
          newAssigneeName = opt ? opt.textContent : '';
        }
        var newDueDate = form.querySelector('[data-edit-due]').value;
        updateDoc(doc(db, 'projects', p.id, 'tasks', taskId), {
          title: newTitle,
          assigneeId: newAssigneeId,
          assigneeName: newAssigneeName,
          dueDate: newDueDate,
          status: task.status
        }).then(function() {
          showToast('Task updated.', 'info');
          var changes = [];
          if (newTitle !== task.title) changes.push('renamed to "' + newTitle + '"');
          if (newAssigneeId !== task.assigneeId) changes.push('reassigned to ' + (newAssigneeName || 'Unassigned'));
          if (newDueDate !== (task.dueDate || '')) changes.push('due date set to ' + (newDueDate || 'none'));
          if (changes.length > 0) {
            logProjectActivity(p.id, 'edited', '"' + (task.title || 'Untitled') + '": ' + changes.join(', '));
          }
          if (projectsState.detailProject) {
            renderProjectDetail(projectsState.detailProject);
          }
        }).catch(function(err) {
          console.error('Task edit error:', err);
          showToast('Failed to update task.', 'error');
        });
      };

      form.querySelector('[data-edit-cancel]').onclick = function() {
        refreshProjectDetailView();
      };
    };
  });

  // Wire task filter pills
  document.querySelectorAll('[data-task-filter]').forEach(function(pill) {
    pill.onclick = function() {
      projectsState.taskFilter = pill.dataset.taskFilter;
      if (projectsState.detailProject) {
        renderProjectDetail(projectsState.detailProject);
      }
    };
  });

  syncSidebarSelection();
};

// ─── Projects: modal ────────────────────────────────────────────────────────
var openProjectModal = function(existingProject) {
  var modal = document.getElementById('projectModal');
  if (!modal) return;

  var titleEl = document.getElementById('projectModalTitle');
  var nameInput = document.getElementById('projectNameInput');
  var descInput = document.getElementById('projectDescInput');
  var statusInput = document.getElementById('projectStatusInput');

  if (titleEl) titleEl.textContent = existingProject ? 'Edit Project' : 'New Project';
  if (nameInput) nameInput.value = existingProject ? (existingProject.name || '') : '';
  if (descInput) descInput.value = existingProject ? (existingProject.description || '') : '';
  if (statusInput) statusInput.value = existingProject ? (existingProject.status || 'active') : 'active';

  // Load member checkboxes
  loadProjectMemberChecks(existingProject);

  // Wire cancel button
  var cancelBtn = document.getElementById('projectModalCancel');
  if (cancelBtn) cancelBtn.onclick = closeProjectModal;

  // Wire backdrop click
  var backdrop = modal.querySelector('.project-modal-backdrop');
  if (backdrop) backdrop.onclick = closeProjectModal;

  modal.classList.add('visible');
};

var closeProjectModal = function() {
  var modal = document.getElementById('projectModal');
  if (modal) modal.classList.remove('visible');
};

var loadProjectMemberChecks = function(existingProject) {
  var container = document.getElementById('projectMemberChecks');
  if (!container) return;
  container.innerHTML = '<span class="text-muted">Loading...</span>';

  getDocs(collection(db, 'users')).then(function(snap) {
    if (snap.empty) {
      container.innerHTML = '<span class="text-muted">No members found.</span>';
      return;
    }

    var existingMembers = existingProject && Array.isArray(existingProject.memberIds)
      ? existingProject.memberIds
      : (state.user ? [state.user.uid] : []);

    var html = '';
    snap.forEach(function(d) {
      var u = d.data();
      var memberName = u.name || u.displayName || u.email || 'Member';
      var checked = existingMembers.indexOf(d.id) !== -1 ? ' checked' : '';
      var disabled = d.id === (state.user ? state.user.uid : '') ? ' disabled' : '';
      html += '<label><input type="checkbox" value="' + escapeAttr(d.id) + '" data-name="' + escapeAttr(memberName) + '"' + checked + disabled + ' /> ' + escapeHTML(memberName) + '</label>';
    });
    container.innerHTML = html;
  }).catch(function(err) {
    console.error('Load members error:', err);
    container.innerHTML = '<span class="text-muted">Failed to load members.</span>';
  });
};

// ─── Projects: save (create or update) ──────────────────────────────────────
var handleSaveProject = function() {
  var nameInput = document.getElementById('projectNameInput');
  var descInput = document.getElementById('projectDescInput');
  var statusInput = document.getElementById('projectStatusInput');
  var container = document.getElementById('projectMemberChecks');

  var name = (nameInput ? nameInput.value : '').trim();
  if (!name) {
    showToast('Project name is required.', 'error');
    return;
  }

  var description = (descInput ? descInput.value : '').trim();
  var status = statusInput ? statusInput.value : 'active';

  // Gather selected members
  var memberIds = [];
  var memberNames = {};
  if (container) {
    container.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb) {
      memberIds.push(cb.value);
      memberNames[cb.value] = cb.dataset.name || 'Member';
    });
  }
  // Ensure creator is always included
  if (state.user && memberIds.indexOf(state.user.uid) === -1) {
    memberIds.push(state.user.uid);
    memberNames[state.user.uid] = state.user.displayName || state.user.email || 'Member';
  }

  var saveBtn = document.getElementById('projectModalSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  if (projectsState.editingProjectId) {
    // Update existing
    updateDoc(doc(db, 'projects', projectsState.editingProjectId), {
      name: name,
      description: description,
      status: status,
      memberIds: memberIds,
      memberNames: memberNames,
      updatedAt: serverTimestamp()
    }).then(function() {
      closeProjectModal();
      showToast('Project updated.', 'info');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    }).catch(function(err) {
      console.error('Update project error:', err);
      showToast('Failed to update: ' + (err.message || ''), 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    });
  } else {
    // Create new
    addDoc(collection(db, 'projects'), {
      name: name,
      description: description,
      status: status,
      createdBy: state.user.uid,
      createdByName: state.user.displayName || state.user.email || 'Member',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      memberIds: memberIds,
      memberNames: memberNames
    }).then(function(docRef) {
      closeProjectModal();
      showToast('Project created!', 'info');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      projectsState.activeProjectId = docRef.id;
      syncURLState();
      loadProjectDetail(docRef.id);
    }).catch(function(err) {
      console.error('Create project error:', err);
      showToast('Failed to create: ' + (err.message || ''), 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    });
  }
};

// ─── Projects: add comment ──────────────────────────────────────────────────
var handleProjectComment = function(projectId, body) {
  return addDoc(collection(db, 'projects', projectId, 'comments'), {
    authorId: state.user.uid,
    authorName: state.user.displayName || state.user.email || 'Member',
    body: body,
    createdAt: serverTimestamp()
  }).catch(function(err) {
    console.error('Project comment error:', err);
    showToast('Failed to post comment.', 'error');
  });
};

// ─── Projects: attach file ──────────────────────────────────────────────────
var handleProjectFileAttach = function(projectId, fileData) {
  addDoc(collection(db, 'projects', projectId, 'files'), {
    fileUrl: fileData.fileUrl || '',
    fileName: fileData.fileName || 'File',
    iconUrl: fileData.iconUrl || '',
    addedBy: state.user.uid,
    addedByName: state.user.displayName || state.user.email || 'Member',
    addedAt: serverTimestamp()
  }).then(function() {
    showToast('File attached!', 'info');
  }).catch(function(err) {
    console.error('Project file attach error:', err);
    showToast('Failed to attach file.', 'error');
  });
};

// ─── Projects: add task ────────────────────────────────────────────────────
var logProjectActivity = function(projectId, action, detail) {
  return addDoc(collection(db, 'projects', projectId, 'activity'), {
    action: action,
    detail: detail || '',
    authorId: state.user.uid,
    authorName: state.user.displayName || state.user.email || 'Member',
    createdAt: serverTimestamp()
  }).catch(function(err) {
    console.error('Activity log error:', err);
  });
};

var handleAddTask = function(projectId, taskData) {
  return addDoc(collection(db, 'projects', projectId, 'tasks'), {
    title: taskData.title,
    assigneeId: taskData.assigneeId || '',
    assigneeName: taskData.assigneeName || '',
    dueDate: taskData.dueDate || '',
    status: 'todo',
    createdBy: state.user.uid,
    createdByName: state.user.displayName || state.user.email || 'Member',
    createdAt: serverTimestamp()
  }).then(function() {
    showToast('Task added.', 'info');
    logProjectActivity(projectId, 'created', 'added task "' + taskData.title + '"');
  }).catch(function(err) {
    console.error('Add task error:', err);
    showToast('Failed to add task.', 'error');
  });
};

// ─── URL detection & link preview ───────────────────────────────────────────
var URL_REGEX = /https?:\/\/[^\s<>"'`,;)}\]]+/gi;

var linkifyText = function(escapedHtml) {
  return escapedHtml.replace(URL_REGEX, function(url) {
    var clean = url.replace(/[.,;:!?)]+$/, '');
    var safeUrl = escapeAttr(clean);
    return '<a href="' + safeUrl + '" class="post-link" target="_blank" rel="noopener">' + clean + '</a>';
  });
};

var highlightMentions = function(html) {
  return html.replace(/@(\w[\w\s]{0,30}\w)/g, '<span class="mention">@$1</span>');
};

var extractFirstUrl = function(text) {
  var match = (text || '').match(URL_REGEX);
  if (!match) return '';
  return match[0].replace(/[.,;:!?)]+$/, '');
};

var renderLinkPreview = function(og) {
  if (!og || !og.ogUrl) return '';

  // Fallback card: no title means Microlink couldn't fetch preview
  if (!og.ogTitle) {
    var domain = '';
    try { domain = new URL(og.ogUrl).hostname.replace(/^www\./, ''); } catch(e) { domain = og.ogUrl; }
    return '' +
      '<a class="link-preview-card link-preview-fallback" href="' + escapeAttr(og.ogUrl) + '" target="_blank" rel="noopener">' +
        '<div class="link-preview-text">' +
          '<span class="link-preview-site">&#128279; ' + escapeHTML(domain) + '</span>' +
          '<span class="link-preview-title">' + escapeHTML(og.ogUrl) + '</span>' +
        '</div>' +
      '</a>';
  }

  var img = og.ogImage
    ? '<img class="link-preview-img" src="' + escapeAttr(og.ogImage) + '" alt="" />'
    : '';
  var site = og.ogSite
    ? '<span class="link-preview-site">' + escapeHTML(og.ogSite) + '</span>'
    : '';
  return '' +
    '<a class="link-preview-card" href="' + escapeAttr(og.ogUrl) + '" target="_blank" rel="noopener">' +
      img +
      '<div class="link-preview-text">' +
        site +
        '<span class="link-preview-title">' + escapeHTML(og.ogTitle) + '</span>' +
        (og.ogDescription
          ? '<span class="link-preview-desc">' + escapeHTML(og.ogDescription.substring(0, 150)) + '</span>'
          : '') +
      '</div>' +
    '</a>';
};

var escapeHTML = function(str) {
  var d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
};

var escapeAttr = function(str) {
  return String(str == null ? '' : str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
};

// ─── Init: auth state listener drives the whole app ─────────────────────────
var ensureToastRoot = function() {
  var root = document.getElementById('toastRoot');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'toastRoot';
  root.className = 'toast-root';
  document.body.appendChild(root);
  return root;
};

var showToast = function(message, tone, timeoutMs) {
  var root = ensureToastRoot();
  var toast = document.createElement('div');

  toast.className = 'toast toast-' + (tone || 'info');
  toast.textContent = String(message || '');
  root.appendChild(toast);

  requestAnimationFrame(function() {
    toast.classList.add('toast-visible');
  });

  var dismiss = function() {
    toast.classList.remove('toast-visible');
    window.setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 180);
  };

  toast.addEventListener('click', dismiss);
  window.setTimeout(dismiss, timeoutMs || 3200);
};

var showDialogModal = function(opts) {
  opts = opts || {};

  var existing = document.getElementById('dialogBackdrop');
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }

  return new Promise(function(resolve) {
    var backdrop = document.createElement('div');
    var card = document.createElement('div');
    var title = document.createElement('div');
    var message = document.createElement('div');
    var actions = document.createElement('div');
    var cancelBtn = document.createElement('button');
    var confirmBtn = document.createElement('button');

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

    var close = function(result) {
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

var showNoticeModal = function(title, message, confirmLabel) {
  return showDialogModal({
    title: title,
    message: message,
    confirmLabel: confirmLabel || 'OK',
    hideCancel: true
  });
};

var showConfirmModal = function(title, message, confirmLabel) {
  return showDialogModal({
    title: title,
    message: message,
    confirmLabel: confirmLabel || 'Confirm',
    cancelLabel: 'Cancel',
    tone: 'danger'
  });
};

// ─── Resources ──────────────────────────────────────────────────────────────

var RESOURCE_CATEGORIES = {
  podcast: { label: 'Podcast', color: '#E87040' },
  video:   { label: 'Video',   color: '#6366F1' },
  legal:   { label: 'Legal',   color: '#F59E0B' },
  tool:    { label: 'Tool',    color: '#10B981' },
  general: { label: 'General', color: '#8B5CF6' }
};

var resetResourcesState = function() {
  if (resourcesState.unsubscribe) {
    resourcesState.unsubscribe();
    resourcesState.unsubscribe = null;
  }
  resourcesState.resources = [];
  resourcesState.filter = 'all';
};

var renderResourceList = function() {
  var listEl = document.getElementById('resourceList');
  if (!listEl) return;

  var filtered = resourcesState.filter === 'all'
    ? resourcesState.resources
    : resourcesState.resources.filter(function(r) { return r.category === resourcesState.filter; });

  if (filtered.length === 0) {
    listEl.innerHTML = '<p class="text-muted">No resources yet.</p>';
    return;
  }

  listEl.innerHTML = filtered.map(function(r) {
    var cat = RESOURCE_CATEGORIES[r.category] || RESOURCE_CATEGORIES.general;
    var desc = r.description ? '<p class="resource-desc">' + escapeHTML(r.description) + '</p>' : '';
    var deleteBtn = state.isAdmin
      ? '<button class="btn-ghost resource-delete" data-id="' + r.id + '" title="Delete">&#128465;</button>'
      : '';
    return '<div class="resource-card">' +
      '<div class="resource-card-top">' +
        '<span class="resource-cat-badge" style="background:' + cat.color + ';">' + cat.label + '</span>' +
        deleteBtn +
      '</div>' +
      '<a href="' + escapeAttr(r.url) + '" target="_blank" rel="noopener" class="resource-title">' + escapeHTML(r.title) + '</a>' +
      desc +
      '<div class="resource-meta">Added by ' + escapeHTML(r.addedByName) + (r.createdAt ? ' &middot; ' + (r.createdAt.toDate ? r.createdAt.toDate() : new Date(r.createdAt)).toLocaleDateString() : '') + '</div>' +
    '</div>';
  }).join('');

  listEl.querySelectorAll('.resource-delete').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var rid = btn.getAttribute('data-id');
      showConfirmModal('Delete Resource', 'Remove this resource from the library?', 'Delete').then(function(ok) {
        if (!ok) return;
        deleteDoc(doc(db, 'resources', rid)).catch(function(err) {
          console.error('Delete resource error:', err);
        });
      });
    });
  });
};

var initResourcesPage = function() {
  // Show add form for all signed-in members
  var addForm = document.getElementById('resourceAddForm');
  if (addForm && state.user) addForm.style.display = 'block';

  // Filter pills
  var filtersEl = document.getElementById('resourceFilters');
  if (filtersEl) {
    filtersEl.addEventListener('click', function(e) {
      var pill = e.target.closest('.resource-filter-pill');
      if (!pill) return;
      resourcesState.filter = pill.getAttribute('data-cat');
      filtersEl.querySelectorAll('.resource-filter-pill').forEach(function(p) {
        p.classList.toggle('active', p.getAttribute('data-cat') === resourcesState.filter);
      });
      renderResourceList();
    });
  }

  // Drive picker button
  var driveBtn = document.getElementById('resourceDriveBtn');
  if (driveBtn) {
    driveBtn.addEventListener('click', function() {
      pickerContext = 'resource';
      openDrivePicker();
    });
  }

  // Add button
  var addBtn = document.getElementById('resourceAddBtn');
  if (addBtn) {
    addBtn.addEventListener('click', function() {
      var title = document.getElementById('resourceTitle').value.trim();
      var url   = document.getElementById('resourceUrl').value.trim();
      var desc  = document.getElementById('resourceDesc').value.trim();
      var cat   = document.getElementById('resourceCategory').value;

      if (!title || !url) return;
      if (!/^https?:\/\//i.test(url)) {
        showToast('URL must start with http:// or https://', 'error');
        return;
      }

      addBtn.disabled = true;
      addDoc(collection(db, 'resources'), {
        title:       title,
        url:         url,
        description: desc,
        category:    cat,
        addedBy:     state.user.uid,
        addedByName: state.user.displayName || state.user.email || 'Member',
        createdAt:   serverTimestamp()
      }).then(function() {
        document.getElementById('resourceTitle').value = '';
        document.getElementById('resourceUrl').value = '';
        document.getElementById('resourceDesc').value = '';
        document.getElementById('resourceCategory').value = 'general';
      }).catch(function(err) {
        console.error('Add resource error:', err);
      }).finally(function() {
        addBtn.disabled = false;
      });
    });
  }

  // Subscribe to resources collection
  if (resourcesState.unsubscribe) resourcesState.unsubscribe();

  var q = query(collection(db, 'resources'), orderBy('createdAt', 'desc'));
  resourcesState.unsubscribe = onSnapshot(q, function(snap) {
    resourcesState.resources = snap.docs.map(function(d) {
      var data = d.data();
      data.id = d.id;
      return data;
    });
    renderResourceList();
  }, function(err) {
    console.error('Resources subscribe error:', err);
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
