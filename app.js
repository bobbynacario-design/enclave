// app.js — Enclave entry point

import {
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

import {
  doc,
  getDoc,
  collection,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { auth, db, googleProvider } from './firebase.js';

// ─── State ───────────────────────────────────────────────────────────────────
var state = {
  currentPage:  'feed',
  user:         null,
  accessDenied: false
};

var feedState = {
  posts:       [],
  filter:      'all',
  unsubscribe: null
};

// ─── Auth: sign in / sign out ────────────────────────────────────────────────
var handleSignIn = function() {
  state.accessDenied = false;
  signInWithPopup(auth, googleProvider).catch(function(err) {
    console.error('Sign-in error:', err);
  });
};

var handleSignOut = function() {
  state.accessDenied = false;
  signOut(auth);
};

// ─── Auth: allowlist check ───────────────────────────────────────────────────
var checkAllowlist = function(user) {
  if (!user.email) {
    state.accessDenied = true;
    signOut(auth);
    return;
  }

  var emailKey = user.email.toLowerCase();
  var ref      = doc(db, 'allowlist', emailKey);

  getDoc(ref).then(function(snap) {
    if (snap.exists()) {
      state.user = user;
      renderShell();
    } else {
      state.accessDenied = true;
      signOut(auth);
    }
  }).catch(function(err) {
    console.error('Allowlist check failed:', err);
    state.accessDenied = true;
    signOut(auth);
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
        '<div class="login-logo">ENCLAVE</div>' +
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

// ─── Render: app shell (logged in) ───────────────────────────────────────────
var renderShell = function() {
  var appEl = document.getElementById('app');

  fetch('components/shell.html').then(function(res) {
    if (!res.ok) throw new Error('shell HTTP ' + res.status);
    return res.text();
  }).then(function(shellHTML) {
    appEl.innerHTML = shellHTML;

    // Nav links
    document.querySelectorAll('.sidebar-link[data-page]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        loadPage(btn.dataset.page);
      });
    });

    // Sign out
    var signOutBtn = document.querySelector('[data-action="sign-out"]');
    if (signOutBtn) signOutBtn.addEventListener('click', handleSignOut);

    // User profile row
    if (state.user) {
      var nameEl  = document.querySelector('[data-slot="user-name"]');
      var emailEl = document.querySelector('[data-slot="user-email"]');
      var avEl    = document.querySelector('[data-slot="user-avatar"]');
      if (nameEl)  nameEl.textContent  = state.user.displayName || 'Member';
      if (emailEl) emailEl.textContent = state.user.email || '';
      if (avEl && state.user.photoURL) {
        avEl.style.backgroundImage = 'url(' + state.user.photoURL + ')';
      }
    }

    loadPage(state.currentPage);
  }).catch(function(err) {
    console.error('Failed to load shell:', err);
    appEl.innerHTML = '<div id="loading">Failed to load shell.</div>';
  });
};

// ─── Page loader ─────────────────────────────────────────────────────────────
var loadPage = function(page) {
  state.currentPage = page;

  // Clean up any previous page subscriptions
  if (feedState.unsubscribe) {
    feedState.unsubscribe();
    feedState.unsubscribe = null;
  }

  var slot = document.querySelector('[data-slot="page"]');
  if (!slot) return;

  // Highlight active nav link
  document.querySelectorAll('.sidebar-link[data-page]').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  fetch('pages/' + page + '.html').then(function(res) {
    if (!res.ok) throw new Error('page HTTP ' + res.status);
    return res.text();
  }).then(function(pageHTML) {
    slot.innerHTML = pageHTML;

    // Page-specific init
    if (page === 'feed') initFeedPage();
  }).catch(function(err) {
    console.error('Failed to load page ' + page + ':', err);
    slot.innerHTML = '<div class="card"><p class="text-muted">Failed to load ' + page + '.</p></div>';
  });
};

// ─── Feed: init ──────────────────────────────────────────────────────────────
var initFeedPage = function() {
  // Compose avatar
  var composeAv = document.querySelector('[data-slot="compose-avatar"]');
  if (composeAv && state.user) {
    if (state.user.photoURL) {
      composeAv.style.backgroundImage = 'url(' + state.user.photoURL + ')';
      composeAv.textContent = '';
    } else {
      composeAv.textContent = getInitials(state.user.displayName || state.user.email);
    }
  }

  // Compose submit
  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn) submitBtn.addEventListener('click', handleComposeSubmit);

  // Filter pills
  document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
    pill.addEventListener('click', function() {
      feedState.filter = pill.dataset.filter;
      document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
        p.classList.toggle('active', p === pill);
      });
      renderFeedList();
    });
  });

  // Reset filter to current (in case re-entering page)
  document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
    p.classList.toggle('active', p.dataset.filter === feedState.filter);
  });

  // Subscribe to live posts feed
  subscribeFeed();
};

// ─── Feed: live subscription ─────────────────────────────────────────────────
var subscribeFeed = function() {
  var q = query(collection(db, 'posts'), orderBy('timestamp', 'desc'));

  feedState.unsubscribe = onSnapshot(q, function(snap) {
    feedState.posts = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      feedState.posts.push(data);
    });
    renderFeedList();
  }, function(err) {
    console.error('Feed subscribe error:', err);
    var list = document.getElementById('feedList');
    if (list) list.innerHTML = '<div class="card"><p class="text-muted">Failed to load feed. Check Firestore rules.</p></div>';
  });
};

// ─── Feed: compose submit ────────────────────────────────────────────────────
var handleComposeSubmit = function() {
  var bodyEl   = document.getElementById('composeBody');
  var circleEl = document.getElementById('composeCircle');
  if (!bodyEl || !circleEl || !state.user) return;

  var body   = bodyEl.value.trim();
  var circle = circleEl.value;
  if (!body) return;

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

  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn) {
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Posting...';
  }

  addDoc(collection(db, 'posts'), post).then(function() {
    bodyEl.value = '';
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
    alert('Failed to post. Check console for details.');
  });
};

// ─── Feed: render list ───────────────────────────────────────────────────────
var renderFeedList = function() {
  var list = document.getElementById('feedList');
  if (!list) return;

  var posts = feedState.posts;
  if (feedState.filter !== 'all') {
    posts = posts.filter(function(p) { return p.circle === feedState.filter; });
  }

  if (posts.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No posts yet. Be the first to share.</p></div>';
    return;
  }

  list.innerHTML = posts.map(renderPostCard).join('');
};

// ─── Feed: render single post card ───────────────────────────────────────────
var renderPostCard = function(p) {
  var circleLabels = {
    'all':          'All',
    'poker-crew':   'Poker Crew',
    'work-network': 'Work Network',
    'family':       'Family'
  };
  var circleLabel = circleLabels[p.circle] || p.circle || 'All';

  var time = (p.timestamp && typeof p.timestamp.toDate === 'function')
    ? relativeTime(p.timestamp.toDate())
    : 'just now';

  var nameEsc     = escapeHTML(p.authorName || 'Unknown');
  var initialsEsc = escapeHTML(p.authorInitials || '?');
  var bodyEsc     = escapeHTML(p.body || '');

  var reactCount   = (p.reacts   || []).length;
  var commentCount = (p.comments || []).length;

  var reactLbl   = 'React'   + (reactCount   ? ' ' + reactCount   : '');
  var commentLbl = 'Comment' + (commentCount ? ' ' + commentCount : '');

  return '' +
    '<div class="post-card">' +
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
      '<div class="post-actions">' +
        '<button class="post-action">&#9825; ' + reactLbl + '</button>' +
        '<button class="post-action">&#128172; ' + commentLbl + '</button>' +
        '<button class="post-action">&#8599; Share</button>' +
      '</div>' +
    '</div>';
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
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

var escapeHTML = function(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
};

// ─── Init: auth state listener drives the whole app ─────────────────────────
onAuthStateChanged(auth, function(user) {
  if (user) {
    renderLoading('Checking access...');
    checkAllowlist(user);
  } else {
    state.user = null;
    renderLogin();
  }
});
