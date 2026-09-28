import { LEGACY_CIRCLES, LEGACY_CIRCLE_IDS, MAX_VISIBLE_CIRCLES } from './constants.js';
import { escapeHTML } from './escape.js';

// ─── Circle directory ─────────────────────────────────────────────────────────
// Names and owners of the circles this person can see, loaded from the
// `circles` collection at sign-in (see loadCircleDirectory in shell.js).
// Membership itself lives on users/{uid}.circles, which the rules check.
var directory = {};

var LEGACY_NAMES = {};
LEGACY_CIRCLES.forEach(function(c) { LEGACY_NAMES[c.id] = c.name; });

var VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const setCircleDirectory = function(list) {
  directory = {};
  (list || []).forEach(function(circle) {
    if (circle && circle.id) directory[circle.id] = circle;
  });
};

export const getCircle = function(id) {
  return directory[id] || null;
};

export const isLegacyCircle = function(id) {
  return LEGACY_CIRCLE_IDS.indexOf(id) !== -1;
};

export const normalizeCircles = function(circles) {
  if (!Array.isArray(circles)) return [];

  return circles.filter(function(circle, index) {
    return typeof circle === 'string' &&
      circle !== 'all' &&
      VALID_ID.test(circle) &&
      circles.indexOf(circle) === index;
  });
};

// 'all' plus the circles this person can read. Admins also see the legacy
// circles (they own them); circles other members create stay private to
// their members, admins included.
export const getVisibleCircles = function(state) {
  var own = normalizeCircles(state.circles);
  var circles = state.isAdmin ? LEGACY_CIRCLE_IDS.concat(own) : own;

  circles = circles.filter(function(circle, index) {
    return circles.indexOf(circle) === index;
  }).slice(0, MAX_VISIBLE_CIRCLES);

  return ['all'].concat(circles);
};

// Only the circles the viewer can see — for showing another member's circles
// without revealing private circles the viewer isn't in.
export const sharedCircles = function(memberCircles, state) {
  var visible = getVisibleCircles(state);
  return normalizeCircles(memberCircles).filter(function(circle) {
    return visible.indexOf(circle) !== -1;
  });
};

export const getInitials = function(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

export const circleLabel = function(id) {
  if (id === 'all') return 'All';
  if (directory[id] && directory[id].name) return directory[id].name;
  return LEGACY_NAMES[id] || 'Private circle';
};

// Circle ids in name order, for lists people scan.
export const sortCircles = function(ids) {
  return ids.slice().sort(function(a, b) {
    return circleLabel(a).localeCompare(circleLabel(b));
  });
};

// The viewer's circles without the 'all' pseudo-circle, in name order.
export const listVisibleCircles = function(state) {
  return sortCircles(getVisibleCircles(state).filter(function(c) { return c !== 'all'; }));
};

// True when this person looks after the circle. They can remove posts and
// events there (the rules check the same thing).
export const isCircleOwner = function(circleId, state) {
  var circle = directory[circleId];
  return !!(circle && state.user && circle.ownerId === state.user.uid);
};

// Where someone can add events: admins anywhere they can see, including All
// members; everyone else the circles members started that they're in.
export const eventCircleIds = function(state) {
  if (state.isAdmin) return ['all'].concat(listVisibleCircles(state));
  return listVisibleCircles(state).filter(function(c) { return !isLegacyCircle(c); });
};

// Circles someone can post to: the ones they can see.
export const renderCircleOptions = function(includeAll, state) {
  var circles = listVisibleCircles(state);
  var html = includeAll ? '<option value="all">All members</option>' : '';

  return html + circles.map(function(circle) {
    return '<option value="' + escapeHTML(circle) + '">' + escapeHTML(circleLabel(circle)) + '</option>';
  }).join('');
};

// Admins assign only the legacy circles by hand; member circles are managed
// by the people in them on the Circles page.
export const renderCircleChecks = function(selectedCircles) {
  const selected = normalizeCircles(selectedCircles);

  return LEGACY_CIRCLE_IDS.map(function(circle) {
    const checked = selected.indexOf(circle) !== -1 ? ' checked' : '';
    return '' +
      '<label class="circle-check">' +
        '<input type="checkbox" value="' + escapeHTML(circle) + '"' + checked + ' />' +
        '<span>' + escapeHTML(circleLabel(circle)) + '</span>' +
      '</label>';
  }).join('');
};

export const getCheckedCircles = function(containerSelector) {
  const selected = [];

  document.querySelectorAll(containerSelector + ' input[type="checkbox"]').forEach(function(cb) {
    if (cb.checked) selected.push(cb.value);
  });

  return normalizeCircles(selected);
};

// An admin edit only changes legacy circles: keep every member circle the
// person already belongs to, and take the legacy ones from the checkboxes.
// The Firestore rules refuse any admin write that changes anything else.
export const mergeAssignedCircles = function(existingCircles, checkedCircles) {
  var keep = normalizeCircles(existingCircles).filter(function(c) { return !isLegacyCircle(c); });
  var legacy = normalizeCircles(checkedCircles).filter(isLegacyCircle);
  return legacy.concat(keep);
};
