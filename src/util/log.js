// Centralized error logging. Wraps console.error today; will route
// to a remote sink (Sentry, etc.) in a later phase.
export const logError = function(context, err) {
  // eslint-disable-next-line no-console
  console.error('[' + context + ']', err);
};
