// app.js — Enclave entry point

import {
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  getDocs,
  serverTimestamp,
  Timestamp,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { auth, db, googleProvider } from './firebase.js';

var ALL_CIRCLES = [
  'poker-crew',
  'work-network',
  'family'
];

// ─── State ───────────────────────────────────────────────────────────────────
var state = {
  currentPage:  'feed',
  user:         null,
  accessDenied: false,
  isAdmin:      false,
  circles:      []
};

var eventsState = {
  events: []
};

var feedState = {
  posts:       [],
  filter:      'all',
  unsubscribe: null
};

var membersState = {
  members: []
};

var adminState = {
  allowlist: []
};

// ─── Auth: sign in / sign out ────────────────────────────────────────────────
var handleSignIn = function() {
  state.accessDenied = false;
  signInWithPopup(auth, googleProvider).catch(function(err) {
    console.error('Sign-in error:', err);
  });
};

var handleSignOut = function() {
  state.accessDenied = false;
  state.isAdmin = false;
  state.circles = [];
  adminState.allowlist = [];
  signOut(auth);
};

// ─── Auth: allowlist check ───────────────────────────────────────────────────
var checkAllowlist = function(user) {
  if (!user.email) {
    state.accessDenied = true;
    signOut(auth);
    return;
  }

  var emailKey = user.email.toLowerCase();
  var ref      = doc(db, 'allowlist', emailKey);

  getDoc(ref).then(function(snap) {
    if (snap.exists()) {
      state.user = user;
      upsertUserDoc(user, snap.data() || {}).then(function() {
        renderShell();
      }).catch(function(err) {
        console.error('User bootstrap failed:', err);
        renderShell();
      });
    } else {
      state.accessDenied = true;
      signOut(auth);
    }
  }).catch(function(err) {
    console.error('Allowlist check failed:', err);
    state.accessDenied = true;
    signOut(auth);
  });
};

// ─── User doc upsert (runs on every sign-in) ─────────────────────────────────
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
      state.isAdmin = existing.role === 'admin';
      state.circles = state.isAdmin
        ? normalizeCircles(existing.circles)
        : allowedCircles.slice();

      var updatePayload = Object.assign({}, base);
      if (!state.isAdmin) {
        updatePayload.circles = allowedCircles.slice();
      }

      return updateDoc(ref, updatePayload).catch(function(err) {
        console.error('User doc update failed:', err);
      });
    } else {
      state.isAdmin = false;
      state.circles = allowedCircles.slice();
      base.joinedAt = serverTimestamp();
      base.bio      = '';
      base.role     = '';
      base.circles  = allowedCircles.slice();
      return setDoc(ref, base).catch(function(err) {
        console.error('User doc create failed:', err);
      });
    }
  });
};

// ─── Render: loading screen ──────────────────────────────────────────────────
var renderLoading = function(msg) {
  var app = document.getElementById('app');
  app.innerHTML = '<div id="loading">' + (msg || 'Loading...') + '</div>';
};

// ─── Render: login screen ────────────────────────────────────────────────────
var renderLogin = function() {
  var app = document.getElementById('app');

  var deniedHTML = state.accessDenied
    ? '<div class="login-error">Access restricted. You need an invite.</div>'
    : '';

  app.innerHTML =
    '<div class="login-wrap">' +
      '<div class="login-card">' +
        '<div class="login-logo">ENCLAVE</div>' +
        '<div class="login-tagline">private &middot; invite-only</div>' +
        deniedHTML +
        '<button id="googleSignInBtn" class="btn-google">' +
          '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">' +
            '<path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>' +
            '<path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>' +
            '<path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>' +
            '<path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>' +
          '</svg>' +
          '<span>Sign in with Google</span>' +
        '</button>' +
      '</div>' +
    '</div>';

  document.getElementById('googleSignInBtn').addEventListener('click', handleSignIn);
};

// Cache-buster for HTML fragment fetches — bumped per release to defeat
// browser/CDN caching of components and pages.
var ASSET_VERSION = 'v21';

// ─── Render: app shell (logged in) ───────────────────────────────────────────
var renderShell = function() {
  var appEl = document.getElementById('app');

  fetch('components/shell.html?' + ASSET_VERSION).then(function(res) {
    if (!res.ok) throw new Error('shell HTTP ' + res.status);
    return res.text();
  }).then(function(shellHTML) {
    appEl.innerHTML = shellHTML;

    // Nav links
    var adminLink = document.querySelector('.sidebar-link[data-page="admin"]');
    if (adminLink) adminLink.hidden = !state.isAdmin;

    document.querySelectorAll('.sidebar-link[data-page]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        window.enclaveGoPage(btn.dataset.page);
      });
    });

    document.querySelectorAll('.sidebar-link[data-circle]').forEach(function(btn) {
      btn.hidden = getVisibleCircles().indexOf(btn.dataset.circle) === -1;
      btn.addEventListener('click', function() {
        window.enclaveGoCircle(btn.dataset.circle);
      });
    });

    // Sign out
    var signOutBtn = document.querySelector('[data-action="sign-out"]');
    if (signOutBtn) signOutBtn.addEventListener('click', handleSignOut);

    // User profile row
    if (state.user) {
      var nameEl  = document.querySelector('[data-slot="user-name"]');
      var emailEl = document.querySelector('[data-slot="user-email"]');
      var avEl    = document.querySelector('[data-slot="user-avatar"]');
      if (nameEl)  nameEl.textContent  = state.user.displayName || 'Member';
      if (emailEl) emailEl.textContent = state.user.email || '';
      if (avEl && state.user.photoURL) {
        avEl.style.backgroundImage = 'url(' + state.user.photoURL + ')';
      }
    }

    syncSidebarSelection();
    loadPanelEvents();
    loadPage(state.currentPage);
  }).catch(function(err) {
    console.error('Failed to load shell:', err);
    appEl.innerHTML = '<div id="loading">Failed to load shell.</div>';
  });
};

window.enclaveGoPage = function(page) {
  if (page === 'feed') {
    feedState.filter = 'all';
  }
  loadPage(page);
};

window.enclaveGoCircle = function(circle) {
  feedState.filter = circle;
  loadPage('feed');
};

// ─── Right panel: upcoming events ────────────────────────────────────────────
var loadPanelEvents = function() {
  console.log('[enclave] loadPanelEvents START');
  var el = document.getElementById('panelEvents');
  if (!el) {
    console.warn('[enclave] #panelEvents element NOT FOUND — shell may be cached. Hard refresh required.');
    return;
  }
  console.log('[enclave] #panelEvents found, querying...');

  var q = query(collection(db, 'events'), orderBy('date', 'asc'), limit(5));
  getDocs(q).then(function(snap) {
    console.log('[enclave] panel events query returned', snap.size, 'docs');
    var now = Date.now();
    var items = [];
    snap.forEach(function(d) {
      var data = d.data();
      var t = data.date && typeof data.date.toDate === 'function'
        ? data.date.toDate().getTime()
        : 0;
      if (t >= now - 3600000) {
        items.push(data);
      }
    });

    if (items.length === 0) {
      el.className = 'panel-empty';
      el.textContent = 'No upcoming events.';
      return;
    }

    el.className = 'panel-events';
    el.innerHTML = items.slice(0, 4).map(function(ev) {
      var titleEsc = escapeHTML(ev.title || 'Untitled');
      var when = '';
      if (ev.date && typeof ev.date.toDate === 'function') {
        var d = ev.date.toDate();
        when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
          ' · ' +
          d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      }
      var locEsc = escapeHTML(ev.location || '');
      return '' +
        '<div class="panel-event">' +
          '<div class="panel-event-title">' + titleEsc + '</div>' +
          '<div class="panel-event-meta">' + escapeHTML(when) + '</div>' +
          (locEsc ? '<div class="panel-event-meta">' + locEsc + '</div>' : '') +
        '</div>';
    }).join('');
  }).catch(function(err) {
    console.error('Failed to load panel events:', err);
    el.className = 'panel-empty';
    el.textContent = 'Failed to load events.';
  });
};

// ─── Page loader ─────────────────────────────────────────────────────────────
var loadPage = function(page) {
  if (page === 'admin' && !state.isAdmin) {
    page = 'feed';
  }

  state.currentPage = page;

  // Clean up any previous page subscriptions
  if (feedState.unsubscribe) {
    feedState.unsubscribe();
    feedState.unsubscribe = null;
  }

  var slot = document.querySelector('[data-slot="page"]');
  if (!slot) return;

  // Highlight active nav link
  syncSidebarSelection();

  fetch('pages/' + page + '.html?' + ASSET_VERSION).then(function(res) {
    if (!res.ok) throw new Error('page HTTP ' + res.status);
    return res.text();
  }).then(function(pageHTML) {
    slot.innerHTML = pageHTML;

    // Page-specific init
    if (page === 'feed')    initFeedPage();
    if (page === 'members') initMembersPage();
    if (page === 'events')  initEventsPage();
    if (page === 'admin')   initAdminPage();
  }).catch(function(err) {
    console.error('Failed to load page ' + page + ':', err);
    slot.innerHTML = '<div class="card"><p class="text-muted">Failed to load ' + page + '.</p></div>';
  });
};

// ─── Feed: init ──────────────────────────────────────────────────────────────
var initFeedPage = function() {
  var visibleCircles = getVisibleCircles();

  if (visibleCircles.indexOf(feedState.filter) === -1) {
    feedState.filter = 'all';
  }

  var composeAv = document.querySelector('[data-slot="compose-avatar"]');
  if (composeAv && state.user) {
    if (state.user.photoURL) {
      composeAv.style.backgroundImage = 'url(' + state.user.photoURL + ')';
      composeAv.textContent = '';
    } else {
      composeAv.textContent = getInitials(state.user.displayName || state.user.email);
    }
  }

  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn) submitBtn.addEventListener('click', handleComposeSubmit);

  var composeCircle = document.getElementById('composeCircle');
  if (composeCircle) {
    composeCircle.querySelectorAll('option').forEach(function(option) {
      option.hidden = visibleCircles.indexOf(option.value) === -1;
    });

    if (visibleCircles.indexOf(composeCircle.value) === -1) {
      composeCircle.value = 'all';
    }
  }

  document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
    pill.hidden = visibleCircles.indexOf(pill.dataset.filter) === -1;
  });

  document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
    pill.addEventListener('click', function() {
      feedState.filter = pill.dataset.filter;
      document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
        p.classList.toggle('active', p === pill);
      });
      syncSidebarSelection();
      renderFeedList();
    });
  });

  document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
    p.classList.toggle('active', p.dataset.filter === feedState.filter);
  });

  syncSidebarSelection();
  subscribeFeed();
};

// ─── Feed: live subscription ─────────────────────────────────────────────────
var subscribeFeed = function() {
  var q = query(
    collection(db, 'posts'),
    where('circle', 'in', getVisibleCircles()),
    orderBy('timestamp', 'desc')
  );

  feedState.unsubscribe = onSnapshot(q, function(snap) {
    feedState.posts = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      feedState.posts.push(data);
    });
    renderFeedList();
  }, function(err) {
    console.error('Feed subscribe error:', err);
    var list = document.getElementById('feedList');
    if (list) list.innerHTML = '<div class="card"><p class="text-muted">Failed to load feed. Check Firestore rules.</p></div>';
  });
};

// ─── Feed: compose submit ────────────────────────────────────────────────────
var handleComposeSubmit = function() {
  var bodyEl   = document.getElementById('composeBody');
  var circleEl = document.getElementById('composeCircle');
  if (!bodyEl || !circleEl || !state.user) return;

  var body   = bodyEl.value.trim();
  var circle = circleEl.value;
  if (!body) return;

  var displayName = state.user.displayName || state.user.email;

  var post = {
    authorId:       state.user.uid,
    authorName:     displayName,
    authorInitials: getInitials(displayName),
    circle:         circle,
    body:           body,
    timestamp:      serverTimestamp(),
    reacts:         [],
    comments:       []
  };

  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn) {
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Posting...';
  }

  addDoc(collection(db, 'posts'), post).then(function() {
    bodyEl.value = '';
    if (submitBtn) {
      submitBtn.disabled    = false;
      submitBtn.textContent = 'Post';
    }
  }).catch(function(err) {
    console.error('Failed to post:', err);
    if (submitBtn) {
      submitBtn.disabled    = false;
      submitBtn.textContent = 'Post';
    }
    alert('Failed to post. Check console for details.');
  });
};

// ─── Feed: render list ───────────────────────────────────────────────────────
var renderFeedList = function() {
  var list = document.getElementById('feedList');
  if (!list) return;

  var posts = feedState.posts;
  if (feedState.filter !== 'all') {
    posts = posts.filter(function(p) { return p.circle === feedState.filter; });
  }

  if (posts.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No posts yet. Be the first to share.</p></div>';
    return;
  }

  list.innerHTML = posts.map(renderPostCard).join('');
};

// ─── Feed: render single post card ───────────────────────────────────────────
var renderPostCard = function(p) {
  var circleLabels = {
    'all':          'All',
    'poker-crew':   'Poker Crew',
    'work-network': 'Work Network',
    'family':       'Family'
  };
  var circleLabel = circleLabels[p.circle] || p.circle || 'All';

  var time = (p.timestamp && typeof p.timestamp.toDate === 'function')
    ? relativeTime(p.timestamp.toDate())
    : 'just now';

  var nameEsc     = escapeHTML(p.authorName || 'Unknown');
  var initialsEsc = escapeHTML(p.authorInitials || '?');
  var bodyEsc     = escapeHTML(p.body || '');

  var reactCount   = (p.reacts   || []).length;
  var commentCount = (p.comments || []).length;

  var reactLbl   = 'React'   + (reactCount   ? ' ' + reactCount   : '');
  var commentLbl = 'Comment' + (commentCount ? ' ' + commentCount : '');

  return '' +
    '<div class="post-card">' +
      '<div class="post-header">' +
        '<div class="post-avatar">' + initialsEsc + '</div>' +
        '<div class="post-meta">' +
          '<div class="post-author">' + nameEsc + '</div>' +
          '<div class="post-submeta">' +
            '<span class="post-circle">' + circleLabel + '</span>' +
            '<span class="post-dot">&middot;</span>' +
            '<span class="post-time">' + time + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="post-body">' + bodyEsc + '</div>' +
      '<div class="post-actions">' +
        '<button class="post-action">&#9825; ' + reactLbl + '</button>' +
        '<button class="post-action">&#128172; ' + commentLbl + '</button>' +
        '<button class="post-action">&#8599; Share</button>' +
      '</div>' +
    '</div>';
};

// ─── Members: init ───────────────────────────────────────────────────────────
var initMembersPage = function() {
  loadMembers();

  // Delegate close handlers on the modal
  document.querySelectorAll('[data-action="close-profile"]').forEach(function(el) {
    el.addEventListener('click', closeProfile);
  });
};

// ─── Members: load ───────────────────────────────────────────────────────────
var loadMembers = function() {
  var list = document.getElementById('membersList');
  if (!list) return;

  getDocs(collection(db, 'users')).then(function(usersSnap) {
    var members = [];
    usersSnap.forEach(function(d) {
      var data = d.data();
      data.uid = d.id;
      members.push(data);
    });

    // Sort alphabetically by name
    members.sort(function(a, b) {
      return (a.name || '').localeCompare(b.name || '');
    });

    membersState.members = members;
    renderMembersList();
  }).catch(function(err) {
    console.error('Failed to load members:', err);
    list.innerHTML = '<div class="card"><p class="text-muted">Failed to load members. Check Firestore rules.</p></div>';
  });
};

// ─── Admin: init ──────────────────────────────────────────────────────────────
var initAdminPage = function() {
  if (!state.isAdmin) {
    loadPage('feed');
    return;
  }

  var inviteBtn = document.getElementById('adminInviteBtn');
  if (inviteBtn) inviteBtn.addEventListener('click', handleAdminInvite);

  loadAllowlistMembers();
};

// ─── Admin: load allowlist ────────────────────────────────────────────────────
var loadAllowlistMembers = function() {
  var list = document.getElementById('adminMembersList');
  if (!list) return;

  getDocs(collection(db, 'allowlist')).then(function(snap) {
    var entries = [];

    snap.forEach(function(d) {
      var data = d.data() || {};
      entries.push({
        email:   (data.email || d.id || '').toLowerCase(),
        circles: normalizeCircles(data.circles)
      });
    });

    entries.sort(function(a, b) {
      return a.email.localeCompare(b.email);
    });

    adminState.allowlist = entries;
    renderAllowlistMembers();
  }).catch(function(err) {
    console.error('Failed to load allowlist:', err);
    list.innerHTML = '<div class="card"><p class="text-muted">Failed to load allowlist. Check Firestore rules.</p></div>';
  });
};

// ─── Admin: render allowlist ──────────────────────────────────────────────────
var renderAllowlistMembers = function() {
  var list = document.getElementById('adminMembersList');
  if (!list) return;

  if (adminState.allowlist.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No invited emails yet.</p></div>';
    return;
  }

  list.innerHTML = adminState.allowlist.map(function(entry) {
    var circleTags = entry.circles.map(function(circleId) {
      return '<span class="circle-tag">' + escapeHTML(circleLabel(circleId)) + '</span>';
    }).join('');

    if (!circleTags) {
      circleTags = '<span class="circle-tag circle-tag-empty">No circles assigned</span>';
    }

    return '' +
      '<div class="card admin-member-row">' +
        '<div class="admin-member-meta">' +
          '<div class="admin-member-email">' + escapeHTML(entry.email) + '</div>' +
          '<div class="member-circles">' + circleTags + '</div>' +
        '</div>' +
        '<button class="btn btn-ghost admin-remove-btn" data-remove-email="' + escapeAttr(entry.email) + '">Remove</button>' +
      '</div>';
  }).join('');

  list.querySelectorAll('[data-remove-email]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleAdminRemove(btn.dataset.removeEmail);
    });
  });
};

// ─── Members: render grid ────────────────────────────────────────────────────
var renderMembersList = function() {
  var list = document.getElementById('membersList');
  if (!list) return;

  if (membersState.members.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No members yet. As people sign in, they\'ll appear here.</p></div>';
    return;
  }

  list.innerHTML = membersState.members.map(renderMemberCard).join('');

  // Wire card clicks
  list.querySelectorAll('.member-card').forEach(function(card) {
    card.addEventListener('click', function() {
      openProfile(card.dataset.uid);
    });
  });
};

// ─── Admin: invite / remove actions ───────────────────────────────────────────
var handleAdminInvite = function() {
  if (!state.isAdmin || !state.user) return;

  var emailEl = document.getElementById('adminInviteEmail');
  var saveBtn = document.getElementById('adminInviteBtn');
  if (!emailEl || !saveBtn) return;

  var email = emailEl.value.trim().toLowerCase();
  var circles = getCheckedCircles('#adminInviteCircles');

  if (!email) {
    alert('Email is required.');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    alert('Enter a valid email address.');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  var ref = doc(db, 'allowlist', email);
  var existing = adminState.allowlist.find(function(entry) {
    return entry.email === email;
  });

  var payload = {
    email:     email,
    circles:   circles,
    invitedBy: state.user.uid,
    updatedAt: serverTimestamp()
  };

  if (!existing) {
    payload.createdAt = serverTimestamp();
  }

  setDoc(ref, payload, { merge: true }).then(function() {
    return syncUserDocsForAllowlist(email, circles);
  }).then(function() {
    emailEl.value = '';
    setCheckedCircles('#adminInviteCircles', []);
    return loadAllowlistMembers();
  }).catch(function(err) {
    console.error('Failed to save allowlist entry:', err);
    alert('Failed to save invite. Check console for details.');
  }).finally(function() {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Invite';
  });
};

var handleAdminRemove = function(email) {
  if (!state.isAdmin || !email) return;

  if (!window.confirm('Remove ' + email + ' from the allowlist?')) {
    return;
  }

  deleteDoc(doc(db, 'allowlist', email)).then(function() {
    return syncUserDocsForAllowlist(email, []);
  }).then(function() {
    adminState.allowlist = adminState.allowlist.filter(function(entry) {
      return entry.email !== email;
    });
    renderAllowlistMembers();
  }).catch(function(err) {
    console.error('Failed to remove allowlist entry:', err);
    alert('Failed to remove invite. Check console for details.');
  });
};

var syncUserDocsForAllowlist = function(email, circles) {
  var normalized = normalizeCircles(circles);
  var usersQuery = query(collection(db, 'users'), where('email', '==', email));

  return getDocs(usersQuery).then(function(snap) {
    var updates = [];

    snap.forEach(function(userSnap) {
      var userData = userSnap.data() || {};
      if (userData.role === 'admin') return;

      updates.push(updateDoc(doc(db, 'users', userSnap.id), {
        circles: normalized.slice()
      }));

      if (state.user && state.user.uid === userSnap.id) {
        state.circles = normalized.slice();
        document.querySelectorAll('.sidebar-link[data-circle]').forEach(function(btn) {
          btn.hidden = getVisibleCircles().indexOf(btn.dataset.circle) === -1;
        });
        syncSidebarSelection();
      }

      var member = membersState.members.find(function(item) {
        return item.uid === userSnap.id;
      });
      if (member) {
        member.circles = normalized.slice();
      }
    });

    return Promise.all(updates);
  });
};

// ─── Members: render single card ─────────────────────────────────────────────
var renderMemberCard = function(m) {
  var nameEsc     = escapeHTML(m.name || 'Unknown');
  var initialsEsc = escapeHTML(m.initials || '?');
  var roleBio     = m.role || m.bio || '';
  var roleBioEsc  = escapeHTML(roleBio || '—');

  var avatarStyle = m.photoURL
    ? ' style="background-image:url(' + escapeAttr(m.photoURL) + ')"'
    : '';
  var avatarText = m.photoURL ? '' : initialsEsc;

  var circles = Array.isArray(m.circles) ? m.circles : [];
  var circleTags = circles.map(function(c) {
    return '<span class="circle-tag">' + escapeHTML(circleLabel(c)) + '</span>';
  }).join('');
  if (!circleTags) {
    circleTags = '<span class="circle-tag circle-tag-empty">No circles</span>';
  }

  return '' +
    '<div class="member-card" data-uid="' + escapeAttr(m.uid) + '">' +
      '<div class="member-avatar"' + avatarStyle + '>' + avatarText + '</div>' +
      '<div class="member-name">' + nameEsc + '</div>' +
      '<div class="member-role">' + roleBioEsc + '</div>' +
      '<div class="member-circles">' + circleTags + '</div>' +
    '</div>';
};

// ─── Members: profile modal open/close ──────────────────────────────────────
var openProfile = function(uid) {
  var member = membersState.members.find(function(m) { return m.uid === uid; });
  if (!member) return;

  var modal = document.getElementById('profileModal');
  var body  = document.getElementById('profileModalBody');
  if (!modal || !body) return;

  var nameEsc     = escapeHTML(member.name || 'Unknown');
  var initialsEsc = escapeHTML(member.initials || '?');
  var bioEsc      = escapeHTML(member.bio || 'No bio yet.');
  var roleEsc     = escapeHTML(member.role || 'Member');

  var avatarStyle = member.photoURL
    ? ' style="background-image:url(' + escapeAttr(member.photoURL) + ')"'
    : '';
  var avatarText = member.photoURL ? '' : initialsEsc;

  var circles = Array.isArray(member.circles) ? member.circles : [];
  var circleTags = circles.map(function(c) {
    return '<span class="circle-tag">' + escapeHTML(circleLabel(c)) + '</span>';
  }).join('');
  if (!circleTags) {
    circleTags = '<span class="text-muted">Not in any circles.</span>';
  }

  var isSelf = state.user && state.user.uid === uid;
  var editBtnHTML = isSelf
    ? '<button class="btn btn-primary profile-edit-btn" id="profileEditBtn">Edit Profile</button>'
    : '';

  body.innerHTML =
    '<div class="profile-header">' +
      '<div class="profile-avatar-lg"' + avatarStyle + '>' + avatarText + '</div>' +
      '<div class="profile-header-meta">' +
        '<h2 class="profile-name">' + nameEsc + '</h2>' +
        '<p class="text-muted">' + roleEsc + '</p>' +
      '</div>' +
      editBtnHTML +
    '</div>' +
    '<div class="profile-section">' +
      '<div class="profile-section-title">Bio</div>' +
      '<p>' + bioEsc + '</p>' +
    '</div>' +
    '<div class="profile-section">' +
      '<div class="profile-section-title">Circles</div>' +
      '<div class="member-circles">' + circleTags + '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<div class="profile-section-title">Recent Posts</div>' +
      '<div id="profilePosts"><p class="text-muted">Loading...</p></div>' +
    '</div>';

  if (isSelf) {
    var editBtn = document.getElementById('profileEditBtn');
    if (editBtn) {
      editBtn.addEventListener('click', function() {
        renderEditProfileForm(member);
      });
    }
  }

  modal.hidden = false;
  loadRecentPosts(uid);
};

// ─── Members: edit profile form ─────────────────────────────────────────────
var renderEditProfileForm = function(member) {
  var body = document.getElementById('profileModalBody');
  if (!body) return;

  var bioVal  = escapeAttr(member.bio  || '');
  var roleVal = escapeAttr(member.role || '');
  var currentCircles = Array.isArray(member.circles) ? member.circles : [];

  var allCircles = [
    { id: 'poker-crew',   label: 'Poker Crew'   },
    { id: 'work-network', label: 'Work Network' },
    { id: 'family',       label: 'Family'       }
  ];

  var circleChecks = allCircles.map(function(c) {
    var checked = currentCircles.indexOf(c.id) !== -1 ? ' checked' : '';
    return '' +
      '<label class="circle-check">' +
        '<input type="checkbox" value="' + c.id + '"' + checked + ' />' +
        '<span>' + c.label + '</span>' +
      '</label>';
  }).join('');

  body.innerHTML =
    '<div class="profile-header">' +
      '<div class="profile-header-meta">' +
        '<h2 class="profile-name">Edit Profile</h2>' +
        '<p class="text-muted">Update your bio, role, and circles.</p>' +
      '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="editRole">Role</label>' +
      '<input type="text" id="editRole" class="edit-input" maxlength="60" placeholder="e.g. Founder, Developer" value="' + roleVal + '" />' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="editBio">Bio</label>' +
      '<textarea id="editBio" class="edit-input edit-textarea" rows="4" maxlength="280" placeholder="Tell the enclave about yourself...">' + bioVal + '</textarea>' +
    '</div>' +
    '<div class="profile-section">' +
      '<div class="profile-section-title">Circles</div>' +
      '<div class="circle-checks">' + circleChecks + '</div>' +
    '</div>' +
    '<div class="edit-actions">' +
      '<button class="btn" id="editCancelBtn">Cancel</button>' +
      '<button class="btn btn-primary" id="editSaveBtn">Save</button>' +
    '</div>';

  document.getElementById('editCancelBtn').addEventListener('click', function() {
    openProfile(member.uid);
  });
  document.getElementById('editSaveBtn').addEventListener('click', function() {
    handleSaveProfile(member.uid);
  });
};

// ─── Members: save profile edits ────────────────────────────────────────────
var handleSaveProfile = function(uid) {
  if (!state.user || state.user.uid !== uid) return;

  var roleEl = document.getElementById('editRole');
  var bioEl  = document.getElementById('editBio');
  var saveBtn = document.getElementById('editSaveBtn');
  if (!roleEl || !bioEl) return;

  var newRole = roleEl.value.trim();
  var newBio  = bioEl.value.trim();

  var checks = document.querySelectorAll('.circle-checks input[type="checkbox"]');
  var newCircles = [];
  checks.forEach(function(cb) {
    if (cb.checked) newCircles.push(cb.value);
  });

  if (saveBtn) {
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving...';
  }

  var ref = doc(db, 'users', uid);
  updateDoc(ref, {
    role:    newRole,
    bio:     newBio,
    circles: newCircles
  }).then(function() {
    state.circles = newCircles.slice();
    document.querySelectorAll('.sidebar-link[data-circle]').forEach(function(btn) {
      btn.hidden = getVisibleCircles().indexOf(btn.dataset.circle) === -1;
    });
    syncSidebarSelection();

    // Update local cache so UI reflects change without a full reload
    var member = membersState.members.find(function(m) { return m.uid === uid; });
    if (member) {
      member.role    = newRole;
      member.bio     = newBio;
      member.circles = newCircles;
    }
    renderMembersList();
    openProfile(uid);
  }).catch(function(err) {
    console.error('Failed to save profile:', err);
    alert('Failed to save profile. Check console for details.');
    if (saveBtn) {
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Save';
    }
  });
};

var closeProfile = function() {
  var modal = document.getElementById('profileModal');
  if (modal) modal.hidden = true;
};

// ─── Members: recent posts for profile modal ────────────────────────────────
var loadRecentPosts = function(uid) {
  var container = document.getElementById('profilePosts');
  if (!container) return;

  var q = query(
    collection(db, 'posts'),
    where('authorId', '==', uid),
    where('circle', 'in', getVisibleCircles()),
    orderBy('timestamp', 'desc'),
    limit(5)
  );

  getDocs(q).then(function(snap) {
    var posts = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      posts.push(data);
    });

    if (posts.length === 0) {
      container.innerHTML = '<p class="text-muted">No posts yet.</p>';
      return;
    }

    container.innerHTML = posts.map(renderPostCard).join('');
  }).catch(function(err) {
    console.error('Failed to load recent posts:', err);
    // If it's a missing-index error, Firestore returns a specific message
    var msg = err && err.message && err.message.indexOf('index') !== -1
      ? 'Posts query needs a Firestore index. Check browser console for a link to create it.'
      : 'Failed to load posts.';
    container.innerHTML = '<p class="text-muted">' + msg + '</p>';
  });
};

// ─── Events: init ────────────────────────────────────────────────────────────
var initEventsPage = function() {
  var createBtn = document.getElementById('createEventBtn');
  if (createBtn) {
    createBtn.hidden = true;
    createBtn.addEventListener('click', function() {
      window.enclaveCreateEvent();
    });
  }

  var modalCloseBtn = document.querySelector('#eventModal .profile-modal-close');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  var modalBackdrop = document.querySelector('#eventModal .profile-modal-backdrop');
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  // Always render the composer if user is signed in. Firestore rules enforce
  // admin-only writes — non-admins will get a clear permission error.
  if (state.user) {
    renderInlineEventComposer();
  }
  loadEvents();
};

// Globally-exposed functions for inline onclick handlers in page HTML.
window.enclaveCreateEvent = function() {
  if (!state.isAdmin) return;
  openCreateEventModal();
};

window.enclaveCloseEvent = function() {
  closeEventModal();
};

// ─── Events: load upcoming ───────────────────────────────────────────────────
var loadEvents = function() {
  var list = document.getElementById('eventsList');
  if (!list) return;

  var q = query(
    collection(db, 'events'),
    where('circle', 'in', getVisibleCircles()),
    orderBy('date', 'asc')
  );

  getDocs(q).then(function(snap) {
    var events = [];
    var now = Date.now();
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      // Filter to upcoming (date >= now) client-side
      var t = data.date && typeof data.date.toDate === 'function'
        ? data.date.toDate().getTime()
        : 0;
      if (t >= now - 3600000) { // 1h grace period for "in-progress" events
        events.push(data);
      }
    });
    eventsState.events = events;
    renderEventsList();
  }).catch(function(err) {
    console.error('Failed to load events:', err);
    list.innerHTML = '<div class="card"><p class="text-muted">Failed to load events. Check Firestore rules.</p></div>';
  });
};

// ─── Events: render list ─────────────────────────────────────────────────────
var renderEventsList = function() {
  var list = document.getElementById('eventsList');
  if (!list) return;

  if (eventsState.events.length === 0) {
    list.innerHTML = '<div class="card"><p class="text-muted">No upcoming events. ' +
      (state.isAdmin ? 'Click "Create Event" to add one.' : 'Check back soon.') + '</p></div>';
    return;
  }

  list.innerHTML = eventsState.events.map(renderEventCard).join('');

  list.querySelectorAll('[data-rsvp]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleRsvp(btn.dataset.rsvp, btn);
    });
  });

  if (state.user) {
    eventsState.events.forEach(function(ev) {
      var rsvpRef = doc(db, 'events', ev.id, 'rsvps', state.user.uid);
      getDoc(rsvpRef).then(function(snap) {
        if (!snap.exists()) return;

        var btn = list.querySelector('[data-rsvp="' + ev.id + '"]');
        if (!btn) return;

        btn.classList.add('rsvped');
        btn.textContent = rsvpButtonLabel(ev.rsvpCount, true);
      }).catch(function() { /* ignore */ });
    });
  }
};

// ─── Events: render single card ──────────────────────────────────────────────
var renderEventCard = function(ev) {
  var titleEsc    = escapeHTML(ev.title    || 'Untitled');
  var locationEsc = escapeHTML(ev.location || 'TBD');
  var circleLbl   = escapeHTML(circleLabel(ev.circle || 'all'));
  var descEsc     = escapeHTML(ev.description || '');

  var when = 'TBD';
  if (ev.date && typeof ev.date.toDate === 'function') {
    var d = ev.date.toDate();
    when = d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric'
    }) + ' · ' + d.toLocaleTimeString(undefined, {
      hour: 'numeric', minute: '2-digit'
    });
  }

  var rsvpCount = (typeof ev.rsvpCount === 'number') ? ev.rsvpCount : 0;

  return '' +
    '<div class="event-card">' +
      '<div class="event-card-header">' +
        '<div class="event-title">' + titleEsc + '</div>' +
        '<span class="post-circle">' + circleLbl + '</span>' +
      '</div>' +
      '<div class="event-meta">' +
        '<div class="event-meta-row">&#128197; ' + escapeHTML(when) + '</div>' +
        '<div class="event-meta-row">&#128205; ' + locationEsc + '</div>' +
      '</div>' +
      (descEsc ? '<div class="event-desc">' + descEsc + '</div>' : '') +
      '<div class="event-actions">' +
        '<button class="btn btn-primary" data-rsvp="' + escapeAttr(ev.id) + '">' + rsvpButtonLabel(rsvpCount, false) + '</button>' +
      '</div>' +
    '</div>';
};

// ─── Events: RSVP toggle ─────────────────────────────────────────────────────
var handleRsvp = function(eventId, btn) {
  if (!state.user || !eventId) return;

  var eventRef = doc(db, 'events', eventId);
  var rsvpRef = doc(db, 'events', eventId, 'rsvps', state.user.uid);

  btn.disabled = true;

  runTransaction(db, function(transaction) {
    return transaction.get(eventRef).then(function(eventSnap) {
      if (!eventSnap.exists()) throw new Error('Event not found.');

      return transaction.get(rsvpRef).then(function(rsvpSnap) {
        var eventData = eventSnap.data() || {};
        var currentCount = typeof eventData.rsvpCount === 'number' ? eventData.rsvpCount : 0;

        if (rsvpSnap.exists()) {
          var nextCount = currentCount > 0 ? currentCount - 1 : 0;
          transaction.delete(rsvpRef);
          transaction.update(eventRef, { rsvpCount: nextCount });
          return {
            count:    nextCount,
            isRsvped: false
          };
        }

        var nextCount = currentCount + 1;
        transaction.set(rsvpRef, {
          uid:       state.user.uid,
          name:      state.user.displayName || state.user.email,
          email:     state.user.email,
          timestamp: serverTimestamp()
        });
        transaction.update(eventRef, { rsvpCount: nextCount });
        return {
          count:    nextCount,
          isRsvped: true
        };
      });
    });
  }).then(function(result) {
    setLocalEventRsvpCount(eventId, result.count);
    btn.classList.toggle('rsvped', result.isRsvped);
    btn.textContent = rsvpButtonLabel(result.count, result.isRsvped);
    btn.disabled = false;
  }).catch(function(err) {
    console.error('Failed to update RSVP:', err);
    alert('Failed to update RSVP. Check console for details.');
    btn.disabled = false;
  });
};

// ─── Events: create event modal (admin only) ────────────────────────────────
var openCreateEventModal = function() {
  if (!state.isAdmin) return;
  var modal = document.getElementById('eventModal');
  var body  = document.getElementById('eventModalBody');
  if (!modal || !body) return;

  // Default to tomorrow 7pm
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var defaultDate = tomorrow.toISOString().slice(0, 10);

  body.innerHTML =
    '<div class="profile-header">' +
      '<div class="profile-header-meta">' +
        '<h2 class="profile-name">Create Event</h2>' +
        '<p class="text-muted">Add a new gathering to the enclave.</p>' +
      '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evTitle">Title</label>' +
      '<input type="text" id="evTitle" class="edit-input" maxlength="80" placeholder="e.g. Poker Night" />' +
    '</div>' +
    '<div class="profile-section event-date-row">' +
      '<div style="flex:1;">' +
        '<label class="profile-section-title" for="evDate">Date</label>' +
        '<input type="date" id="evDate" class="edit-input" value="' + defaultDate + '" />' +
      '</div>' +
      '<div style="flex:1;">' +
        '<label class="profile-section-title" for="evTime">Time</label>' +
        '<input type="time" id="evTime" class="edit-input" value="19:00" />' +
      '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evLocation">Location</label>' +
      '<input type="text" id="evLocation" class="edit-input" maxlength="120" placeholder="e.g. Bob\'s place" />' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evCircle">Circle</label>' +
      '<select id="evCircle" class="edit-input">' +
        '<option value="all">All</option>' +
        '<option value="poker-crew">Poker Crew</option>' +
        '<option value="work-network">Work Network</option>' +
        '<option value="family">Family</option>' +
      '</select>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evDesc">Description</label>' +
      '<textarea id="evDesc" class="edit-input edit-textarea" rows="3" maxlength="400" placeholder="Optional details..."></textarea>' +
    '</div>' +
    '<div class="edit-actions">' +
      '<button class="btn" id="evCancelBtn">Cancel</button>' +
      '<button class="btn btn-primary" id="evSaveBtn">Create</button>' +
    '</div>';

  var cancelBtn = document.getElementById('evCancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  var saveBtn = document.getElementById('evSaveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      window.enclaveSubmitEvent();
    });
  }

  modal.hidden = false;
};

// Expose for inline onclick handlers
window.enclaveSubmitEvent = function() { handleCreateEvent(); };

var closeEventModal = function() {
  var modal = document.getElementById('eventModal');
  if (modal) modal.hidden = true;
};

var handleCreateEvent = function() {
  if (!state.isAdmin || !state.user) return;

  var title    = document.getElementById('evTitle').value.trim();
  var dateVal  = document.getElementById('evDate').value;
  var timeVal  = document.getElementById('evTime').value;
  var location = document.getElementById('evLocation').value.trim();
  var circle   = document.getElementById('evCircle').value;
  var desc     = document.getElementById('evDesc').value.trim();

  if (!title)    { alert('Title is required.');    return; }
  if (!dateVal)  { alert('Date is required.');     return; }
  if (!timeVal)  { alert('Time is required.');     return; }
  if (!location) { alert('Location is required.'); return; }

  // Combine date + time into a JS Date, then Firestore Timestamp
  var combined = new Date(dateVal + 'T' + timeVal);
  if (isNaN(combined.getTime())) {
    alert('Invalid date/time.');
    return;
  }

  var saveBtn = document.getElementById('evSaveBtn');
  if (saveBtn) {
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Creating...';
  }

  var newEvent = {
    title:       title,
    date:        Timestamp.fromDate(combined),
    location:    location,
    circle:      circle,
    description: desc,
    createdBy:   state.user.uid,
    createdAt:   serverTimestamp(),
    rsvpCount:   0
  };

  addDoc(collection(db, 'events'), newEvent).then(function() {
    closeEventModal();
    loadEvents();
  }).catch(function(err) {
    console.error('Failed to create event:', err);
    alert('Failed to create event. Check console for details.');
    if (saveBtn) {
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Create';
    }
  });
};

var renderInlineEventComposer = function() {
  var composer = document.getElementById('eventAdminComposer');
  if (!composer) return;

  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var defaultDate = tomorrow.toISOString().slice(0, 10);

  composer.innerHTML =
    '<div class="card">' +
      '<div class="page-header-row">' +
        '<div>' +
          '<h2 class="profile-name">Create Event</h2>' +
          '<p class="text-muted">Add a new gathering to the enclave.</p>' +
        '</div>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvTitle">Title</label>' +
        '<input type="text" id="inlineEvTitle" class="edit-input" maxlength="80" placeholder="e.g. Poker Night" />' +
      '</div>' +
      '<div class="profile-section event-date-row">' +
        '<div style="flex:1;">' +
          '<label class="profile-section-title" for="inlineEvDate">Date</label>' +
          '<input type="date" id="inlineEvDate" class="edit-input" value="' + defaultDate + '" />' +
        '</div>' +
        '<div style="flex:1;">' +
          '<label class="profile-section-title" for="inlineEvTime">Time</label>' +
          '<input type="time" id="inlineEvTime" class="edit-input" value="19:00" />' +
        '</div>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvLocation">Location</label>' +
        '<input type="text" id="inlineEvLocation" class="edit-input" maxlength="120" placeholder="e.g. Bob\'s place" />' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvCircle">Circle</label>' +
        '<select id="inlineEvCircle" class="edit-input">' +
          '<option value="all">All</option>' +
          '<option value="poker-crew">Poker Crew</option>' +
          '<option value="work-network">Work Network</option>' +
          '<option value="family">Family</option>' +
        '</select>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvDesc">Description</label>' +
        '<textarea id="inlineEvDesc" class="edit-input edit-textarea" rows="3" maxlength="400" placeholder="Optional details..."></textarea>' +
      '</div>' +
      '<div class="edit-actions">' +
        '<button type="button" class="btn btn-primary" id="inlineEvSaveBtn">Create Event</button>' +
      '</div>' +
    '</div>';

  // Direct onclick assignment — not addEventListener, not inline attribute.
  // This is the single most reliable handler wiring in the DOM.
  var btn = document.getElementById('inlineEvSaveBtn');
  if (btn) {
    btn.onclick = function() {
      btn.textContent = 'Working...';
      btn.disabled = true;
      setTimeout(function() {
        handleInlineCreateEvent();
      }, 0);
    };
  }
};

// Expose for inline onclick — bulletproof against addEventListener timing issues
window.enclaveInlineCreate = function() {
  console.log('[enclave] enclaveInlineCreate clicked');
  handleInlineCreateEvent();
};

var handleInlineCreateEvent = function() {
  console.log('[enclave] handleInlineCreateEvent START');
  console.log('[enclave] user=', state.user && state.user.email, 'isAdmin=', state.isAdmin);

  if (!state.user) {
    alert('Not signed in.');
    return;
  }

  var titleEl    = document.getElementById('inlineEvTitle');
  var dateEl     = document.getElementById('inlineEvDate');
  var timeEl     = document.getElementById('inlineEvTime');
  var locationEl = document.getElementById('inlineEvLocation');
  var circleEl   = document.getElementById('inlineEvCircle');
  var descEl     = document.getElementById('inlineEvDesc');
  var saveBtn    = document.getElementById('inlineEvSaveBtn');

  console.log('[enclave] elements found:', {
    title: !!titleEl, date: !!dateEl, time: !!timeEl,
    location: !!locationEl, circle: !!circleEl, desc: !!descEl
  });

  if (!titleEl || !dateEl || !timeEl || !locationEl || !circleEl || !descEl) {
    alert('Form elements missing. See console.');
    return;
  }

  var title    = titleEl.value.trim();
  var dateVal  = dateEl.value;
  var timeVal  = timeEl.value;
  var location = locationEl.value.trim();
  var circle   = circleEl.value;
  var desc     = descEl.value.trim();

  console.log('[enclave] values:', { title: title, dateVal: dateVal, timeVal: timeVal, location: location, circle: circle });

  var resetBtn = function() {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
  };

  if (!title)    { alert('Title is required.');    resetBtn(); return; }
  if (!dateVal)  { alert('Date is required.');     resetBtn(); return; }
  if (!timeVal)  { alert('Time is required.');     resetBtn(); return; }
  if (!location) { alert('Location is required.'); resetBtn(); return; }

  var combined = new Date(dateVal + 'T' + timeVal);
  if (isNaN(combined.getTime())) {
    alert('Invalid date/time.');
    resetBtn();
    return;
  }
  console.log('[enclave] combined date:', combined);

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating...';
  }

  console.log('[enclave] calling addDoc...');
  addDoc(collection(db, 'events'), {
    title:       title,
    date:        Timestamp.fromDate(combined),
    location:    location,
    circle:      circle,
    description: desc,
    createdBy:   state.user.uid,
    createdAt:   serverTimestamp(),
    rsvpCount:   0
  }).then(function(ref) {
    console.log('[enclave] addDoc SUCCESS, id=', ref.id);
    loadPanelEvents();
    titleEl.value = '';
    locationEl.value = '';
    descEl.value = '';
    circleEl.value = 'all';
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
    loadEvents();
  }).catch(function(err) {
    console.error('Failed to create event:', err);
    var msg;
    if (err.code === 'permission-denied') {
      msg = 'PERMISSION DENIED.\n\n' +
        'Firestore rejected the write. Two things to check:\n\n' +
        '1. Firebase Console → Firestore → Rules: paste the full ruleset that includes the /events/{eventId} block (with the /rsvps/{uid} subcollection) and click Publish.\n\n' +
        '2. Firebase Console → Firestore → users → your uid doc: the "role" field must be exactly the string "admin" (lowercase).';
    } else {
      msg = 'Failed to create event.\n\n' + (err.code || '') + '\n' + (err.message || '');
    }
    alert(msg);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
  });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
var normalizeCircles = function(circles) {
  if (!Array.isArray(circles)) return [];

  return circles.filter(function(circle, index) {
    return ALL_CIRCLES.indexOf(circle) !== -1 && circles.indexOf(circle) === index;
  });
};

var getCheckedCircles = function(containerSelector) {
  var selected = [];

  document.querySelectorAll(containerSelector + ' input[type="checkbox"]').forEach(function(cb) {
    if (cb.checked) selected.push(cb.value);
  });

  return normalizeCircles(selected);
};

var setCheckedCircles = function(containerSelector, circles) {
  var normalized = normalizeCircles(circles);

  document.querySelectorAll(containerSelector + ' input[type="checkbox"]').forEach(function(cb) {
    cb.checked = normalized.indexOf(cb.value) !== -1;
  });
};

var getInitials = function(name) {
  if (!name) return '?';
  var parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

var relativeTime = function(date) {
  var sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 5)      return 'just now';
  if (sec < 60)     return sec + 's ago';
  if (sec < 3600)   return Math.floor(sec / 60)    + 'm ago';
  if (sec < 86400)  return Math.floor(sec / 3600)  + 'h ago';
  if (sec < 604800) return Math.floor(sec / 86400) + 'd ago';
  return date.toLocaleDateString();
};

var circleLabel = function(id) {
  var labels = {
    'all':          'All',
    'poker-crew':   'Poker Crew',
    'work-network': 'Work Network',
    'family':       'Family'
  };
  return labels[id] || id;
};

var getVisibleCircles = function() {
  var circles = state.isAdmin
    ? ALL_CIRCLES.slice()
    : (Array.isArray(state.circles) ? state.circles.slice() : []);

  circles.unshift('all');

  return circles.filter(function(circle, index) {
    return circles.indexOf(circle) === index;
  });
};

var syncSidebarSelection = function() {
  document.querySelectorAll('.sidebar-link[data-page]').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.page === state.currentPage);
  });

  document.querySelectorAll('.sidebar-link[data-circle]').forEach(function(btn) {
    var isActive = state.currentPage === 'feed' &&
      feedState.filter !== 'all' &&
      btn.dataset.circle === feedState.filter;

    btn.classList.toggle('active', isActive);
  });
};

var rsvpButtonLabel = function(count, isRsvped) {
  var total = typeof count === 'number' ? count : 0;
  var countLabel = total > 0 ? ' (' + total + ')' : '';
  return (isRsvped ? 'Going' : 'RSVP') + countLabel;
};

var setLocalEventRsvpCount = function(eventId, count) {
  eventsState.events = eventsState.events.map(function(eventItem) {
    if (eventItem.id !== eventId) return eventItem;
    eventItem.rsvpCount = count;
    return eventItem;
  });
};

var escapeHTML = function(str) {
  var d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
};

var escapeAttr = function(str) {
  return String(str == null ? '' : str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
};

// ─── Init: auth state listener drives the whole app ─────────────────────────
onAuthStateChanged(auth, function(user) {
  if (user) {
    renderLoading('Checking access...');
    checkAllowlist(user);
  } else {
    state.user = null;
    state.isAdmin = false;
    state.circles = [];
    adminState.allowlist = [];
    renderLogin();
  }
});
