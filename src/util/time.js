export const getFirestoreTimeMs = function(value) {
  if (value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  var parsed = new Date(value || 0).getTime();
  return isNaN(parsed) ? 0 : parsed;
};

export const formatCalendarMonthLabel = function(year, month) {
  return new Date(year, month, 1).toLocaleDateString([], {
    month: 'long',
    year: 'numeric'
  });
};

export const relativeTime = function(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 5)      return 'just now';
  if (sec < 60)     return sec + 's ago';
  if (sec < 3600)   return Math.floor(sec / 60)    + 'm ago';
  if (sec < 86400)  return Math.floor(sec / 3600)  + 'h ago';
  if (sec < 604800) return Math.floor(sec / 86400) + 'd ago';
  return date.toLocaleDateString();
};
