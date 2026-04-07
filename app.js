// app.js — Enclave entry point

import { auth, db, storage } from './firebase.js';

// ─── State ───────────────────────────────────────────────────────────────────
var state = {
  currentPage: 'feed',
  user: null
};

// ─── Router ──────────────────────────────────────────────────────────────────
var navigate = function(page) {
  state.currentPage = page;

  document.querySelectorAll('.page').forEach(function(el) {
    el.classList.remove('active');
  });

  var target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');

  document.querySelectorAll('#nav .nav-links button').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
};

// ─── Render shell ────────────────────────────────────────────────────────────
var renderShell = function() {
  var app = document.getElementById('app');

  app.innerHTML =
    '<nav id="nav">' +
      '<span class="logo">Enclave</span>' +
      '<div class="nav-links">' +
        '<button data-page="feed">Feed</button>' +
        '<button data-page="events">Events</button>' +
        '<button data-page="members">Members</button>' +
        '<button data-page="messages">Messages</button>' +
      '</div>' +
    '</nav>' +
    '<div id="page-feed"     class="page"></div>' +
    '<div id="page-events"   class="page"></div>' +
    '<div id="page-members"  class="page"></div>' +
    '<div id="page-messages" class="page"></div>';

  document.querySelectorAll('#nav .nav-links button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var page = btn.dataset.page;
      loadPage(page);
      navigate(page);
    });
  });

  loadPage(state.currentPage);
  navigate(state.currentPage);
};

// ─── Page loader ─────────────────────────────────────────────────────────────
var loadPage = function(page) {
  var pages = {
    feed:     renderFeed,
    events:   renderEvents,
    members:  renderMembers,
    messages: renderMessages
  };

  if (pages[page]) pages[page]();
};

// ─── Pages (stubs — build out in /pages/) ────────────────────────────────────
var renderFeed = function() {
  var el = document.getElementById('page-feed');
  el.innerHTML = '<div class="card"><p class="text-muted">Feed coming soon.</p></div>';
};

var renderEvents = function() {
  var el = document.getElementById('page-events');
  el.innerHTML = '<div class="card"><p class="text-muted">Events coming soon.</p></div>';
};

var renderMembers = function() {
  var el = document.getElementById('page-members');
  el.innerHTML = '<div class="card"><p class="text-muted">Members coming soon.</p></div>';
};

var renderMessages = function() {
  var el = document.getElementById('page-messages');
  el.innerHTML = '<div class="card"><p class="text-muted">Messages coming soon.</p></div>';
};

// ─── Init ────────────────────────────────────────────────────────────────────
var init = function() {
  renderShell();
};

init();
