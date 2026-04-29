import { ALL_CIRCLES } from './constants.js';

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
