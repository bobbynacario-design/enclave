// Firebase
import {
  doc,
  collection,
  addDoc,
  getDocs,
  updateDoc,
  serverTimestamp
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
  getInitials,
  getVisibleCircles
} from '../util/circles.js';
import { logError } from '../util/log.js';
import { loadPage, syncURLState } from '../util/shell-bridge.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { showConfirmModal, wireModalA11y } from '../ui/modals.js';

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
var memberCircleFilter = 'all';

// Focus trap teardown for the profile modal, held while it is open.
var profileTeardown = null;

// ─── Members: init ───────────────────────────────────────────────────────────
export const initMembersPage = function() {
  memberSearchQuery = '';
  memberCircleFilter = 'all';
  loadMembers();

  // Delegate close handlers on the modal
  document.querySelectorAll('[data-action="close-profile"]').forEach(function(el) {
    el.addEventListener('click', closeProfile);
  });

  var searchInput = document.getElementById('membersSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      memberSearchQuery = searchInput.value.trim().toLowerCase();
      renderMembersList();
    });
  }
};

var openMemberMessage = function(uid) {
  if (!uid || (state.user && uid === state.user.uid)) return;
  closeProfile();
  loadPage('messages', { peer: uid });
};

var renderMemberFilters = function() {
  var group = document.getElementById('membersFilterGroup');
  var filters = document.getElementById('membersCircleFilters');
  if (!group || !filters) return;

  var visibleCircles = getVisibleCircles(state).filter(function(circle) {
    return membersState.members.some(function(member) {
      return Array.isArray(member.circles) && member.circles.indexOf(circle) !== -1;
    });
  });

  if (!visibleCircles.length) {
    group.hidden = true;
    return;
  }

  group.hidden = false;
  var choices = [{ id: 'all', label: 'All' }].concat(visibleCircles.map(function(circle) {
    return { id: circle, label: circleLabel(circle) };
  }));
  filters.innerHTML = choices.map(function(choice) {
    var active = memberCircleFilter === choice.id;
    return '<button type="button" class="members-filter-chip' + (active ? ' active' : '') + '" ' +
      'data-member-circle="' + escapeAttr(choice.id) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
      escapeHTML(choice.label) + '</button>';
  }).join('');

  filters.querySelectorAll('[data-member-circle]').forEach(function(button) {
    button.addEventListener('click', function() {
      memberCircleFilter = button.dataset.memberCircle || 'all';
      renderMemberFilters();
      renderMembersList();
    });
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
    renderMemberFilters();
    renderMembersList();
    if (membersState.targetMemberId) {
      if (members.some(function(member) { return member.uid === membersState.targetMemberId; })) {
        openProfile(membersState.targetMemberId);
      } else {
        membersState.targetMemberId = '';
        syncURLState();
      }
    }
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

  var visible = membersState.members.filter(function(m) {
    var matchesCircle = memberCircleFilter === 'all' ||
      (Array.isArray(m.circles) && m.circles.indexOf(memberCircleFilter) !== -1);
    var hay = ((m.name || '') + ' ' + (m.role || '') + ' ' + (m.bio || '') + ' ' +
      (m.email || '') + ' ' + (Array.isArray(m.circles) ? m.circles.map(circleLabel).join(' ') : '')).toLowerCase();
    var matchesSearch = !memberSearchQuery || hay.indexOf(memberSearchQuery) !== -1;
    return matchesCircle && matchesSearch;
  });

  var summary = document.getElementById('membersResultsSummary');
  if (summary) {
    var isFiltered = !!memberSearchQuery || memberCircleFilter !== 'all';
    summary.textContent = visible.length + ' ' + (visible.length === 1 ? 'member' : 'members') +
      (isFiltered ? ' found' : ' in your network');
  }

  if (visible.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No matches</div><p class="empty-state-text">Try another search or circle filter.</p></div>';
    return;
  }

  list.innerHTML = visible.map(renderMemberCard).join('');

  // Wire card clicks
  list.querySelectorAll('[data-open-member]').forEach(function(button) {
    button.addEventListener('click', function() {
      openProfile(button.dataset.openMember);
    });
  });

  list.querySelectorAll('[data-message-member]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      openMemberMessage(btn.dataset.messageMember);
    });
  });

  // Wire promotion buttons — stopPropagation so card click doesn't fire
  list.querySelectorAll('.member-promote-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleMemberPromote(btn);
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

  var adminBadge = m.isAdmin === true
    ? '<span class="member-admin-badge" title="Admin">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;">' +
          '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>' +
        '</svg>' +
        'Admin' +
      '</span>'
    : '';

  var promoteBtn = '';
  if (state.isAdmin && state.user && m.uid !== state.user.uid) {
    var btnLabel = m.isAdmin === true ? 'Remove admin' : 'Make admin';
    var btnDataAction = m.isAdmin === true ? 'demote' : 'promote';
    promoteBtn = '<button class="btn btn-ghost member-promote-btn" ' +
      'data-promote-uid="' + escapeAttr(m.uid) + '" ' +
      'data-promote-action="' + btnDataAction + '" ' +
      'data-promote-name="' + escapeAttr(m.name || m.email || 'this member') + '" ' +
      'data-promote-email="' + escapeAttr(m.email || '') + '" ' +
      '>' + btnLabel + '</button>';
  }

  var messageBtn = state.user && m.uid !== state.user.uid
    ? '<button type="button" class="btn btn-primary member-message-btn" data-message-member="' + escapeAttr(m.uid) + '" ' +
        'aria-label="Start direct message">Message</button>'
    : '<span class="member-self-badge">You</span>';

  return '' +
    '<article class="member-card">' +
      '<button type="button" class="member-card-profile" data-open-member="' + escapeAttr(m.uid) + '" aria-label="View member profile">' +
        '<div class="member-avatar"' + avatarStyle + '>' + avatarText + '</div>' +
        '<div class="member-name">' + nameEsc + '</div>' +
        roleLineHtml +
        '<div class="member-circles">' + circleTags + adminBadge + '</div>' +
      '</button>' +
      '<div class="member-card-actions">' + messageBtn + promoteBtn + '</div>' +
    '</article>';
};

// ─── Members: admin promotion ────────────────────────────────────────────────
var handleMemberPromote = function(btn) {
  if (!state.isAdmin || !state.user) return;
  if (btn.disabled) return;

  var uid    = btn.dataset.promoteUid;
  var action = btn.dataset.promoteAction;
  var name   = btn.dataset.promoteName;
  var email  = btn.dataset.promoteEmail;

  if (!uid || !action) return;

  var verb = action === 'promote' ? 'Make admin' : 'Remove admin';
  var question = action === 'promote'
    ? 'Make ' + name + ' an admin? They will gain full admin powers including the ability to promote/remove other admins.'
    : 'Remove admin powers from ' + name + '? They will lose all admin abilities.';

  showConfirmModal(verb, question, verb).then(function(confirmed) {
    if (!confirmed) return;

    btn.disabled = true;
    btn.textContent = action === 'promote' ? 'Promoting...' : 'Removing...';

    var fromIsAdmin = action === 'promote' ? false : true;
    var toIsAdmin   = action === 'promote' ? true  : false;

    updateDoc(doc(db, 'users', uid), { isAdmin: toIsAdmin }).then(function() {
      return addDoc(collection(db, 'auditLog'), {
        type:        'role-change',
        targetUid:   uid,
        targetEmail: email,
        fromIsAdmin: fromIsAdmin,
        toIsAdmin:   toIsAdmin,
        actorUid:    state.user.uid,
        actorEmail:  state.user.email || '',
        createdAt:   serverTimestamp()
      });
    }).then(function() {
      var msg = action === 'promote'
        ? name + ' is now an admin.'
        : 'Admin powers removed from ' + name + '.';
      showToast(msg, 'success');
      loadMembers();
    }).catch(function(err) {
      logError('Failed to change admin status', err);
      showToast('Failed to change admin status. Check console for details.', 'error');
      btn.disabled = false;
      btn.textContent = action === 'promote' ? 'Make admin' : 'Remove admin';
    });
  });
};

// ─── Members: profile modal open/close ──────────────────────────────────────
var openProfile = function(uid) {
  var member = membersState.members.find(function(m) { return m.uid === uid; });
  if (!member) return;

  var modal = document.getElementById('profileModal');
  var body  = document.getElementById('profileModalBody');
  if (!modal || !body) return;

  membersState.targetMemberId = uid;
  syncURLState();

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
    : '<button class="btn btn-primary profile-edit-btn" id="profileMessageBtn">Message</button>';

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
  } else {
    var messageBtn = document.getElementById('profileMessageBtn');
    if (messageBtn) {
      messageBtn.addEventListener('click', function() {
        openMemberMessage(member.uid);
      });
    }
  }

  modal.hidden = false;

  if (profileTeardown) { profileTeardown(); }
  profileTeardown = wireModalA11y({
    card:    modal.querySelector('.profile-modal-content'),
    label:   (member.name || 'Member') + ' profile',
    onClose: closeProfile
  });

  if (recentPostsLoader) recentPostsLoader(uid);
};

var closeProfile = function() {
  if (profileTeardown) {
    profileTeardown();
    profileTeardown = null;
  }

  var modal = document.getElementById('profileModal');
  if (modal) modal.hidden = true;
  membersState.targetMemberId = '';
  syncURLState();
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
    '<div class="profile-section">' +
      '<div class="profile-section-title">Email</div>' +
      '<label class="digest-toggle">' +
        '<input type="checkbox" id="editDigestOptIn"' + (member.digestOptOut === true ? '' : ' checked') + ' />' +
        '<span>Weekly digest email</span>' +
      '</label>' +
      '<div class="form-help">' +
        'A Monday morning summary of new posts, events, and members.' +
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
  var digestEl = document.getElementById('editDigestOptIn');
  var newDigestOptOut = digestEl ? !digestEl.checked : null;

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

  if (newDigestOptOut !== null) {
    updates.digestOptOut = newDigestOptOut;
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
      if (newDigestOptOut !== null) {
        member.digestOptOut = newDigestOptOut;
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
