// app.js — Enclave entry point

import {
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

import {
  doc,
  getDoc
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { auth, db, googleProvider } from './firebase.js';

// ─── State ───────────────────────────────────────────────────────────────────
var state = {
  currentPage:  'feed',
  user:         null,
  accessDenied: false
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

// ─── Router ──────────────────────────────────────────────────────────────────
var navigate = function(page) {
  state.currentPage = page;

  document.querySelectorAll('.page').forEach(function(el) {
    el.classList.remove('active');
  });

  var target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');

  document.querySelectorAll('#nav .nav-links button').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
};

// ─── Render: app shell (logged in) ───────────────────────────────────────────
var renderShell = function() {
  var app = document.getElementById('app');

  app.innerHTML =
    '<nav id="nav">' +
      '<span class="logo">Enclave</span>' +
      '<div class="nav-links">' +
        '<button data-page="feed">Feed</button>' +
        '<button data-page="events">Events</button>' +
        '<button data-page="members">Members</button>' +
        '<button data-page="messages">Messages</button>' +
      '</div>' +
      '<button id="signOutBtn" class="btn-ghost">Sign out</button>' +
    '</nav>' +
    '<div id="page-feed"     class="page"></div>' +
    '<div id="page-events"   class="page"></div>' +
    '<div id="page-members"  class="page"></div>' +
    '<div id="page-messages" class="page"></div>';

  document.querySelectorAll('#nav .nav-links button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var page = btn.dataset.page;
      loadPage(page);
      navigate(page);
    });
  });

  document.getElementById('signOutBtn').addEventListener('click', handleSignOut);

  loadPage(state.currentPage);
  navigate(state.currentPage);
};

// ─── Page loader ─────────────────────────────────────────────────────────────
var loadPage = function(page) {
  var pages = {
    feed:     renderFeed,
    events:   renderEvents,
    members:  renderMembers,
    messages: renderMessages
  };

  if (pages[page]) pages[page]();
};

// ─── Pages (stubs — build out in /pages/) ────────────────────────────────────
var renderFeed = function() {
  var el = document.getElementById('page-feed');
  el.innerHTML = '<div class="card"><p class="text-muted">Feed coming soon.</p></div>';
};

var renderEvents = function() {
  var el = document.getElementById('page-events');
  el.innerHTML = '<div class="card"><p class="text-muted">Events coming soon.</p></div>';
};

var renderMembers = function() {
  var el = document.getElementById('page-members');
  el.innerHTML = '<div class="card"><p class="text-muted">Members coming soon.</p></div>';
};

var renderMessages = function() {
  var el = document.getElementById('page-messages');
  el.innerHTML = '<div class="card"><p class="text-muted">Messages coming soon.</p></div>';
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
