import { ALL_CIRCLES } from './constants.js';
import { escapeHTML } from './escape.js';

const CIRCLE_LABELS = {
  'hustle-hub': 'Hustle Hub',
  'work-network': 'Work Network',
  'family': 'Family'
};

const getCircleDefinitions = function() {
  return ALL_CIRCLES.map(function(circle) {
    return {
      id: circle,
      label: CIRCLE_LABELS[circle] || circle
    };
  });
};

export const normalizeCircles = function(circles) {
  if (!Array.isArray(circles)) return [];

  return circles.filter(function(circle, index) {
    return ALL_CIRCLES.indexOf(circle) !== -1 && circles.indexOf(circle) === index;
  });
};

export const getVisibleCircles = function(state) {
  const circles = state.isAdmin
    ? ALL_CIRCLES.slice()
    : (Array.isArray(state.circles) ? state.circles.slice() : []);

  circles.unshift('all');

  return circles.filter(function(circle, index) {
    return circles.indexOf(circle) === index;
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

  const circle = getCircleDefinitions().find(function(item) {
    return item.id === id;
  });

  return circle ? circle.label : id;
};

export const renderCircleOptions = function(includeAll) {
  const html = includeAll
    ? '<option value="all">All</option>'
    : '';

  return html + getCircleDefinitions().map(function(circle) {
    return '<option value="' + circle.id + '">' + escapeHTML(circle.label) + '</option>';
  }).join('');
};
