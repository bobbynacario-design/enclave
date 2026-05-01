// Auth module — sign in, sign out, allowlist check, user doc upsert

import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  GoogleAuthProvider as GAP
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { auth, db, googleProvider } from '../../firebase.js';

import {
  state,
  authFlowState,
  feedState,
  projectsState,
  adminState,
  resetProjectDetailState,
  resetMessagesState,
  resetResourcesState,
  resetShellRealtime
} from '../state.js';

import { normalizeCircles, getInitials } from '../util/circles.js';

import { logError } from '../util/log.js';

import { showToast } from '../ui/toast.js';

import { renderShell, applyURLState } from '../util/shell-bridge.js';

// ─── Auth: friendly error handler ────────────────────────────────────────────
var handleSignInError = function(err) {
  var code = err && err.code;
  var message;
  switch (code) {
    case 'auth/network-request-failed':
      message = 'Network error. Check your connection and try again.';
      break;
    case 'auth/popup-blocked':
    case 'auth/popup-closed-by-user':
      message = 'Sign-in popup was blocked or closed. Try again.';
      break;
    case 'auth/cancelled-popup-request':
      // User started a second sign-in attempt — silent
      return;
    case 'auth/account-exists-with-different-credential':
      message = 'An account already exists with this email using a different sign-in method.';
      break;
    case 'auth/user-disabled':
      message = 'This account has been disabled. Contact admin.';
      break;
    case 'auth/operation-not-supported-in-this-environment':
      message = 'Sign-in not supported in this browser. Try Chrome or Safari.';
      break;
    default:
      message = 'Couldn\'t sign in. Please try again.';
      break;
  }
  logError('Sign-in error', err);
  showToast(message, 'error');
};

// ─── Auth: sign in / sign out ─────────────────────────────────────────────────
var runSignOut = function(accessDenied) {
  authFlowState.busy = true;
  state.accessDenied = accessDenied || false;
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

var REDIRECT_ERROR_CODES = [
  'auth/popup-blocked',
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/operation-not-supported-in-this-environment'
];

export var handleSignIn = function() {
  if (authFlowState.busy) return;
  state.accessDenied = false;
  authFlowState.busy = true;
  signInWithPopup(auth, googleProvider).then(function(result) {
    var credential = GAP.credentialFromResult(result);
    if (credential && credential.accessToken) {
      state.googleAccessToken = credential.accessToken;
    }
  }).catch(function(err) {
    // Popup blocked, cancelled, or unsupported — fall back to full-page redirect
    if (REDIRECT_ERROR_CODES.indexOf(err.code) !== -1) {
      return signInWithRedirect(auth, googleProvider);
    }
    // Other errors — show user-friendly message
    handleSignInError(err);
  }).finally(function() {
    // Note: when redirect fires the page navigates away; .finally never
    // runs in the same context. busy gets reset on redirect-return below.
    if (!state.user) authFlowState.busy = false;
  });
};

export var handleSignOut = function() {
  if (authFlowState.busy) return;
  runSignOut(false);
};

// ─── Auth: allowlist check ────────────────────────────────────────────────────
export var checkAllowlist = function(user) {
  if (!user.email) {
    runSignOut('no-email');
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
      runSignOut('no-invite');
    }
  }).catch(function(err) {
    logError('Allowlist check failed', err);
    runSignOut('rules-error');
  });
};

// ─── User doc upsert (runs on every sign-in) ──────────────────────────────────
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

// ─── Redirect return: pick up result if user just came back from redirect ────
// Runs once at module load. onAuthStateChanged in app.js handles the rest.
getRedirectResult(auth).then(function(result) {
  if (result) {
    var credential = GAP.credentialFromResult(result);
    if (credential && credential.accessToken) {
      state.googleAccessToken = credential.accessToken;
    }
    // onAuthStateChanged will fire and call checkAllowlist
  }
}).catch(function(err) {
  // Ignore the common "no pending redirect" non-error
  if (err.code && err.code !== 'auth/null-redirect-result') {
    handleSignInError(err);
  }
});
