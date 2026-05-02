// firebase-messaging-sw.js — Firebase Cloud Messaging service worker
// Auto-loaded by the FCM client. Handles incoming push messages
// when the app is in the background or closed.

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyBC8nqTgaqMp0R45dnKpA44u0S5C3nnbFE',
  authDomain:        'enclave-social.firebaseapp.com',
  projectId:         'enclave-social',
  storageBucket:     'enclave-social.firebasestorage.app',
  messagingSenderId: '834210326738',
  appId:             '1:834210326738:web:61e6ebc4ca892c42dc650b'
});

const messaging = firebase.messaging();

// Background message handler — fires when app is closed or
// not focused. The browser will display the notification
// automatically based on the `notification` field in the payload.

messaging.onBackgroundMessage(function(payload) {
  // Default browser handling of `notification` field is fine.
  // We could customize the notification here if needed.
  // For now, log to confirm receipt.
  console.log('[FCM SW] Background push received:', payload);
});
