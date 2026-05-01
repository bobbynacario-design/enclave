// Auth module — sign in, sign out, allowlist check, user doc upsert

import {
  signInWithPopup,
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

import { renderShell, applyURLState } from '../util/shell-bridge.js';

// ─── Auth: sign in / sign out ─────────────────────────────────────────────────
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
    logError('Sign-in error', err);
  }).finally(function() {
    authFlowState.busy = false;
  });
};

export var handleSignOut = function() {
  if (authFlowState.busy) return;
  runSignOut(false);
};

// ─── Auth: allowlist check ────────────────────────────────────────────────────
export var checkAllowlist = function(user) {
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
