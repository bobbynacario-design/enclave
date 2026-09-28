// Auth module — sign in, sign out, allowlist check, user doc upsert

import {
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  updateProfile,
  reload,
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
  state.needsOnboarding = false;
  adminState.allowlist = [];
  if (feedState.unsubscribe) {
    feedState.unsubscribe();
    feedState.unsubscribe = null;
  }
  feedState.savedPosts = [];
  feedState.savedPostsLoaded = false;
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

// ─── Auth: email + password ───────────────────────────────────────────────────
// Any email address works as long as it is on the allowlist — the same
// checkAllowlist() gate Google sign-in goes through. Email accounts must be
// verified before any data loads: the Firestore/Storage rules trust the
// token's email, so an unverified account could otherwise claim someone
// else's invite. Google accounts arrive already verified.
export var MIN_PASSWORD_LENGTH = 8;

export var emailAuthMessage = function(err) {
  switch (err && err.code) {
    case 'auth/invalid-email':
      return 'That email address doesn\'t look right.';
    case 'auth/missing-password':
      return 'Enter your password.';
    case 'auth/weak-password':
      return 'Use at least ' + MIN_PASSWORD_LENGTH + ' characters for your password.';
    case 'auth/email-already-in-use':
      return 'There\'s already an account for this email. Sign in instead. If you ' +
        'joined with Google, use Continue with Google, or Forgot password to set a password.';
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      // A member who joined with Google has no password yet, and Firebase
      // reports that the same way as a wrong password.
      return 'Email or password is incorrect. If you usually use Continue with Google, ' +
        'you don\'t have a password yet: choose Forgot password to set one. ' +
        'New here? Choose Create account.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/operation-not-allowed':
      return 'Email sign-in isn\'t switched on yet. Use Continue with Google for now.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact the admin.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    default:
      return 'Couldn\'t sign in. Please try again.';
  }
};

// Send the reader back to this page after the emailed link, falling back to
// Firebase's default landing page if this origin isn't an authorized domain.
var CONTINUE_URL_ERRORS = [
  'auth/unauthorized-continue-uri',
  'auth/invalid-continue-uri',
  'auth/missing-continue-uri'
];

var continueSettings = function() {
  return { url: window.location.origin + window.location.pathname };
};

var withContinueFallback = function(send) {
  return send(continueSettings()).catch(function(err) {
    if (CONTINUE_URL_ERRORS.indexOf(err && err.code) !== -1) return send(undefined);
    throw err;
  });
};

var runEmailFlow = function(work) {
  if (authFlowState.busy) return Promise.resolve({ ok: false, message: '' });
  state.accessDenied = false;
  authFlowState.busy = true;
  return work().then(function() {
    return { ok: true };
  }).catch(function(err) {
    logError('Email auth error', err);
    return { ok: false, message: emailAuthMessage(err) };
  }).finally(function() {
    authFlowState.busy = false;
  });
};

var sendVerification = function(user) {
  return withContinueFallback(function(settings) {
    return sendEmailVerification(user, settings);
  });
};

// onAuthStateChanged in app.js picks up the new session from here.
export var handleEmailSignIn = function(email, password) {
  return runEmailFlow(function() {
    return signInWithEmailAndPassword(auth, email, password);
  });
};

export var handleEmailRegister = function(name, email, password) {
  return runEmailFlow(function() {
    return createUserWithEmailAndPassword(auth, email, password).then(function(cred) {
      // The name becomes the member's display name once access is granted.
      return updateProfile(cred.user, { displayName: name }).catch(function(err) {
        logError('Display name update failed', err);
      }).then(function() {
        return sendVerification(cred.user).catch(function(err) {
          logError('Verification email failed', err);
          showToast('We couldn\'t send the verification email. Use Resend on the next screen.', 'error');
        });
      });
    });
  });
};

export var resendVerificationEmail = function() {
  if (!auth.currentUser) return Promise.resolve({ ok: false, message: 'Sign in again first.' });
  return sendVerification(auth.currentUser).then(function() {
    return { ok: true };
  }).catch(function(err) {
    logError('Verification resend failed', err);
    return { ok: false, message: emailAuthMessage(err) };
  });
};

// Deliberately says the same thing whether or not an account exists, so the
// form can't be used to discover who is a member.
export var handlePasswordReset = function(email) {
  return withContinueFallback(function(settings) {
    return sendPasswordResetEmail(auth, email, settings);
  }).then(function() {
    return { ok: true };
  }).catch(function(err) {
    if (err && err.code === 'auth/user-not-found') return { ok: true };
    logError('Password reset error', err);
    return { ok: false, message: emailAuthMessage(err) };
  });
};

// Re-read the account after the member clicks the emailed link. The ID token
// is force-refreshed so Firestore sees the verified email straight away —
// otherwise the cached token keeps email_verified false for up to an hour.
export var refreshEmailVerification = function() {
  var user = auth.currentUser;
  if (!user) return Promise.resolve(null);
  return reload(user).then(function() {
    var current = auth.currentUser;
    if (!current || !current.emailVerified) return null;
    return current.getIdToken(true).then(function() {
      return current;
    });
  });
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
      state.isAdmin = existing.isAdmin === true;
      // Only explicit false opts a member into onboarding. Existing member
      // records predate this field and must not be interrupted retroactively.
      state.needsOnboarding = existing.onboardingCompleted === false;
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
      state.needsOnboarding = true;
      base.joinedAt = serverTimestamp();
      base.bio      = '';
      base.role     = '';
      base.circles  = allowedCircles.slice();
      base.onboardingCompleted = false;
      // The owner admin can set isAdmin during create (rule allows this).
      // Non-owners must omit the field — they get isAdmin set later via
      // the role-change update path by an existing admin.
      if (user.email === 'bobbynacario@gmail.com') {
        base.isAdmin = true;
      }
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
