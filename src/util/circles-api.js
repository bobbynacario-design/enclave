// Calls the `circles` Cloud Function, which makes every change to circle
// membership (see functions/circles.js).

import { httpsCallable } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-functions.js';

import { functions } from '../../firebase.js';

var callCircles = httpsCallable(functions, 'circles');

export const circlesAction = function(action, data) {
  return callCircles(Object.assign({ action: action }, data || {})).then(function(res) {
    return res.data || {};
  });
};

// The function words its own errors for people ("You can invite up to 20
// people a day..."); anything else gets a generic line.
var READABLE = {
  'invalid-argument':    true,
  'permission-denied':   true,
  'not-found':           true,
  'resource-exhausted':  true,
  'failed-precondition': true,
  'unauthenticated':     true
};

export const circlesErrorMessage = function(err) {
  var code = String((err && err.code) || '').replace('functions/', '');
  if (READABLE[code] && err.message) return err.message;
  if (code === 'unavailable') return 'You look to be offline. Try again when you\'re connected.';
  return 'Something went wrong. Try again shortly.';
};
