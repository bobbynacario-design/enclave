// Firebase
import {
  doc,
  collection,
  getDocs,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, membersState } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr } from '../util/escape.js';
import {
  circleLabel,
  renderCircleChecks,
  getCheckedCircles,
  getInitials
} from '../util/circles.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';

// Push notifications
import {
  enablePush,
  disablePush,
  getPushSupport
} from '../util/push.js';

// ─── Callback registry ────────────────────────────────────────────────────────

var recentPostsLoader = null;
export const registerRecentPostsLoader = function(fn) {
  recentPostsLoader = fn;
};

var circlesChangedHandler = null;
export const registerCirclesChangedHandler = function(fn) {
  circlesChangedHandler = fn;
};

var memberSearchQuery = '';

// ─── Members: init ───────────────────────────────────────────────────────────
export const initMembersPage = function() {
  loadMembers();

  // Delegate close handlers on the modal
  document.querySelectorAll('[data-action="close-profile"]').forEach(function(el) {
    el.addEventListener('click', closeProfile);
  });

  // Close profile modal on Esc
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    var modal = document.getElementById('profileModal');
    if (modal && !modal.hidden) {
      closeProfile();
    }
  });

  var searchInput = document.getElementById('membersSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      memberSearchQuery = searchInput.value.trim().toLowerCase();
      renderMembersList();
    });
  }
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
    logError('Failed to load members', err);
    list.innerHTML = '<div class="card"><p class="text-muted">Failed to load members. Check Firestore rules.</p></div>';
  });
};

// ─── Members: render grid ────────────────────────────────────────────────────
var renderMembersList = function() {
  var list = document.getElementById('membersList');
  if (!list) return;

  if (membersState.members.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No members yet</div><p class="empty-state-text">As people join the enclave, they\'ll appear here.</p></div>';
    return;
  }

  var visible = memberSearchQuery
    ? membersState.members.filter(function(m) {
        var hay = ((m.name || '') + ' ' + (m.role || '') + ' ' + (m.email || '')).toLowerCase();
        return hay.indexOf(memberSearchQuery) !== -1;
      })
    : membersState.members;

  if (visible.length === 0 && memberSearchQuery) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No matches</div><p class="empty-state-text">No members match "' + escapeHTML(memberSearchQuery) + '".</p></div>';
    return;
  }

  list.innerHTML = visible.map(renderMemberCard).join('');

  // Wire card clicks
  list.querySelectorAll('.member-card').forEach(function(card) {
    card.addEventListener('click', function() {
      openProfile(card.dataset.uid);
    });
  });
};

// ─── Members: render single card ─────────────────────────────────────────────
var renderMemberCard = function(m) {
  var nameEsc     = escapeHTML(m.name || 'Unknown');
  var initialsEsc = escapeHTML(getInitials(m.name || m.email || '?'));
  var roleBio     = m.role || m.bio || '';
  var roleBioEsc  = escapeHTML(roleBio);

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

  var roleLineHtml = roleBioEsc
    ? '<div class="member-role">' + roleBioEsc + '</div>'
    : '';

  return '' +
    '<div class="member-card" data-uid="' + escapeAttr(m.uid) + '">' +
      '<div class="member-avatar"' + avatarStyle + '>' + avatarText + '</div>' +
      '<div class="member-name">' + nameEsc + '</div>' +
      roleLineHtml +
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
  var initialsEsc = escapeHTML(getInitials(member.name || member.email || '?'));
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
      '<div id="profilePosts">' +
        '<div class="skeleton-card" aria-hidden="true">' +
          '<div class="skeleton-row">' +
            '<div class="skeleton skeleton-avatar"></div>' +
            '<div class="skeleton-stack">' +
              '<div class="skeleton skeleton-line" style="width:40%"></div>' +
              '<div class="skeleton skeleton-line" style="width:20%"></div>' +
            '</div>' +
          '</div>' +
          '<div class="skeleton skeleton-line" style="width:100%"></div>' +
          '<div class="skeleton skeleton-line" style="width:75%;margin-top:4px"></div>' +
        '</div>' +
      '</div>' +
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
  if (recentPostsLoader) recentPostsLoader(uid);
};

var closeProfile = function() {
  var modal = document.getElementById('profileModal');
  if (modal) modal.hidden = true;
};

// ─── Members: edit profile form ─────────────────────────────────────────────
var renderEditProfileForm = function(member) {
  var body = document.getElementById('profileModalBody');
  if (!body) return;

  var bioVal  = escapeAttr(member.bio  || '');
  var roleVal = escapeAttr(member.role || '');
  var currentCircles = Array.isArray(member.circles) ? member.circles : [];
  var canEditCircles = !!state.isAdmin;
  var circlesHTML = canEditCircles
    ? '<div class="circle-check-grid" id="editCircles">' + renderCircleChecks(currentCircles) + '</div>' +
      '<p class="text-muted mt-8">As an admin, you can update your own circle access here.</p>'
    : (function() {
        var circleTags = currentCircles.map(function(c) {
          return '<span class="circle-tag">' + escapeHTML(circleLabel(c)) + '</span>';
        }).join('');
        if (!circleTags) {
          circleTags = '<span class="circle-tag circle-tag-empty">No circles assigned</span>';
        }
        return '<div class="member-circles">' + circleTags + '</div>' +
          '<p class="text-muted mt-8">Ask an admin if you need circle access changed.</p>';
      })();

  body.innerHTML =
    '<div class="profile-header">' +
      '<div class="profile-header-meta">' +
        '<h2 class="profile-name">Edit Profile</h2>' +
        '<p class="text-muted">Update your bio and role.' + (canEditCircles ? ' You can also manage your circles.' : ' Circles are managed by admins.') + '</p>' +
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
      circlesHTML +
    '</div>' +
    '<div class="profile-section profile-section-divider">' +
      '<div class="profile-section-title">Notifications</div>' +
      '<div class="notifications-control">' +
        '<button type="button" id="notificationsToggleBtn" class="btn btn-ghost notifications-toggle-btn">Loading...</button>' +
        '<div class="form-help">' +
          'Get pushes for new messages, comments, mentions, and more.' +
        '</div>' +
      '</div>' +
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

  // Async: determine push support and wire the toggle button
  (function() {
    var notifBtn = document.getElementById('notificationsToggleBtn');
    if (!notifBtn) return;

    getPushSupport().then(function(support) {
      if (support === 'unsupported') {
        notifBtn.textContent = 'Not supported in this browser';
        notifBtn.disabled = true;
      } else if (support === 'denied') {
        notifBtn.textContent = 'Permission denied (check browser settings)';
        notifBtn.disabled = true;
      } else if (support === 'granted') {
        notifBtn.textContent = 'Disable notifications';
        notifBtn.addEventListener('click', function() {
          notifBtn.disabled = true;
          disablePush().then(function() {
            return getPushSupport();
          }).then(function(newSupport) {
            notifBtn.textContent = newSupport === 'granted'
              ? 'Disable notifications'
              : 'Enable notifications';
            notifBtn.disabled = false;
          });
        });
      } else {
        // 'default' — never asked
        notifBtn.textContent = 'Enable notifications';
        notifBtn.addEventListener('click', function() {
          notifBtn.disabled = true;
          enablePush().then(function() {
            return getPushSupport();
          }).then(function(newSupport) {
            notifBtn.textContent = newSupport === 'granted'
              ? 'Disable notifications'
              : 'Enable notifications';
            notifBtn.disabled = false;
          });
        });
      }
    });
  })();
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
  var newCircles = state.isAdmin
    ? getCheckedCircles('#editCircles')
    : null;

  if (saveBtn) {
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving...';
  }

  var ref = doc(db, 'users', uid);
  var updates = {
    role:    newRole,
    bio:     newBio
  };

  if (newCircles) {
    updates.circles = newCircles;
  }

  updateDoc(ref, updates).then(function() {
    // Update local cache so UI reflects change without a full reload
    var member = membersState.members.find(function(m) { return m.uid === uid; });
    if (member) {
      member.role    = newRole;
      member.bio     = newBio;
      if (newCircles) {
        member.circles = newCircles.slice();
      }
    }
    if (newCircles && state.user && state.user.uid === uid) {
      state.circles = newCircles.slice();
      if (circlesChangedHandler) circlesChangedHandler();
    }
    renderMembersList();
    openProfile(uid);
  }).catch(function(err) {
    logError('Failed to save profile', err);
    showToast('Failed to save profile. Check console for details.', 'error');
    if (saveBtn) {
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Save';
    }
  });
};
