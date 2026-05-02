// Push notification utilities. Wraps FCM token registration
// and Firestore token storage.

import {
  getToken,
  deleteToken,
  onMessage
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging.js';

import {
  doc,
  updateDoc,
  arrayUnion,
  arrayRemove
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { db, messagingPromise } from '../../firebase.js';
import { state } from '../state.js';
import { logError } from './log.js';
import { showToast } from '../ui/toast.js';

var VAPID_KEY = 'BISFf7BoZ7wV4j_OhBr76JICT9MgvEBT5PzDXQFzDnzw7Hxw7-5bUyVx1nq3NSOBdSx5eR96zfoap_ZPovJIoYg';

// Returns the current push state for the user:
//   'unsupported' — browser cannot do push
//   'denied'      — user previously denied permission
//   'default'     — never asked; can still ask
//   'granted'     — permission granted (token may or may not be registered)
export var getPushSupport = async function() {
  var messaging = await messagingPromise;
  if (!messaging) return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
};

// Request permission, get FCM token, save to user doc.
// Returns true on success, false on failure or denial.
export var enablePush = async function() {
  var messaging = await messagingPromise;
  if (!messaging) {
    showToast('Push notifications are not supported in this browser.', 'error');
    return false;
  }
  if (!state.user || !state.user.uid) {
    showToast('Sign in first.', 'error');
    return false;
  }

  try {
    // Request browser permission
    var permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Notification permission denied.', 'error');
      return false;
    }

    // Get the FCM token. This also registers with FCM servers.
    var token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (!token) {
      showToast('Could not generate notification token.', 'error');
      return false;
    }

    // Save token to user doc (arrayUnion is idempotent)
    var userRef = doc(db, 'users', state.user.uid);
    await updateDoc(userRef, {
      fcmTokens: arrayUnion(token)
    });

    // Subscribe to in-app foreground messages so we can optionally
    // show toasts when the app is open
    onMessage(messaging, function(payload) {
      // Most users will see the in-app notification badge anyway.
      // Log to confirm wiring works.
      console.log('[FCM] Foreground message:', payload);
    });

    showToast('Notifications enabled.', 'success');
    return true;
  } catch (err) {
    logError('enablePush failed', err);
    showToast('Failed to enable notifications. ' + (err.message || ''), 'error');
    return false;
  }
};

// Delete current token, remove from user doc.
export var disablePush = async function() {
  var messaging = await messagingPromise;
  if (!messaging) return false;
  if (!state.user || !state.user.uid) return false;

  try {
    // Get current token (may already be expired/missing)
    var currentToken = null;
    try {
      currentToken = await getToken(messaging, { vapidKey: VAPID_KEY });
    } catch (err) {
      // Token already gone — fine, proceed
    }

    if (currentToken) {
      // Tell FCM to forget this token
      await deleteToken(messaging);
      // Remove from user doc
      var userRef = doc(db, 'users', state.user.uid);
      await updateDoc(userRef, {
        fcmTokens: arrayRemove(currentToken)
      });
    }

    showToast('Notifications disabled.', 'success');
    return true;
  } catch (err) {
    logError('disablePush failed', err);
    showToast('Failed to disable notifications.', 'error');
    return false;
  }
};
