// Admin page module

import {
  doc,
  collection,
  addDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  where,
  setDoc
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { db } from '../../firebase.js';

import {
  state,
  membersState,
  adminState
} from '../state.js';

import { escapeHTML, escapeAttr } from '../util/escape.js';

import {
  normalizeCircles,
  circleLabel,
  renderCircleChecks,
  getCheckedCircles,
  getVisibleCircles
} from '../util/circles.js';

import { logError } from '../util/log.js';

import { showToast } from '../ui/toast.js';

import { showConfirmModal, showCirclePickerModal } from '../ui/modals.js';

import {
  syncSidebarSelection,
  loadPage,
  getAppURL,
  loadPanelCircles
} from '../util/shell-bridge.js';

// ─── Admin: init ──────────────────────────────────────────────────────────────
export var initAdminPage = function() {
  if (!state.isAdmin) {
    renderAdminAccessDenied();
    return;
  }

  var inviteChecks = document.getElementById('adminInviteCircles');
  if (inviteChecks) { inviteChecks.innerHTML = renderCircleChecks([]); }

  var bulkChecks = document.getElementById('adminBulkCircles');
  if (bulkChecks) { bulkChecks.innerHTML = renderCircleChecks([]); }

  var inviteBtn = document.getElementById('adminInviteBtn');
  if (inviteBtn) inviteBtn.addEventListener('click', handleAdminInvite);

  var bulkBtn = document.getElementById('adminBulkInviteBtn');
  if (bulkBtn) bulkBtn.addEventListener('click', handleAdminBulkInvite);

  loadAllowlistMembers();
};

var renderAdminAccessDenied = function() {
  var list = document.querySelector('[data-slot="page"]');
  if (!list) return;

  list.innerHTML =
    '<div class="page-header">' +
      '<h1>Admin</h1>' +
      '<p class="text-muted">Manage invites and circle access.</p>' +
    '</div>' +
    '<div class="card">' +
      '<h2 class="profile-name">Admin access required</h2>' +
      '<p class="text-muted">This signed-in account is not loading as an admin.</p>' +
      '<p class="text-muted mt-16">Signed in as: ' + escapeHTML((state.user && state.user.email) || 'Unknown account') + '</p>' +
      '<div class="edit-actions">' +
        '<button class="btn btn-primary" id="adminBackToFeedBtn">Back to Feed</button>' +
      '</div>' +
    '</div>';

  var backBtn = document.getElementById('adminBackToFeedBtn');
  if (backBtn) {
    backBtn.addEventListener('click', function() {
      loadPage('feed');
    });
  }
};

// ─── Admin: load allowlist ────────────────────────────────────────────────────
var loadAllowlistMembers = function() {
  var list = document.getElementById('adminMembersList');
  if (!list) return;

  Promise.all([
    getDocs(collection(db, 'allowlist')),
    getDocs(collection(db, 'users'))
  ]).then(function(results) {
    var allowlistSnap = results[0];
    var usersSnap = results[1];

    adminState.usersByEmail = {};
    usersSnap.forEach(function(d) {
      var e = (d.data().email || '').toLowerCase();
      if (e) { adminState.usersByEmail[e] = d.data(); }
    });

    var entries = [];
    allowlistSnap.forEach(function(d) {
      var data = d.data() || {};
      var email = (data.email || d.id || '').toLowerCase();
      entries.push({
        email:   email,
        circles: normalizeCircles(data.circles),
        pending: !adminState.usersByEmail[email]
      });
    });

    entries.sort(function(a, b) { return a.email.localeCompare(b.email); });
    adminState.allowlist = entries;
    renderAllowlistMembers();
  }).catch(function(err) {
    logError('Failed to load allowlist', err);
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

    var pendingBadge = entry.pending
      ? '<span class="circle-tag circle-tag-empty">Pending</span>'
      : '';

    var resendBtn = entry.pending
      ? '<button class="btn btn-ghost" data-resend-email="' + escapeAttr(entry.email) + '">Resend</button>'
      : '';

    return '' +
      '<div class="card admin-member-row">' +
        '<div class="admin-member-meta">' +
          '<div class="admin-member-email">' + escapeHTML(entry.email) + '</div>' +
          '<div class="member-circles">' + circleTags + pendingBadge + '</div>' +
        '</div>' +
        resendBtn +
        '<button class="btn btn-ghost" data-edit-email="' + escapeAttr(entry.email) + '">Edit</button>' +
        '<button class="btn btn-ghost admin-remove-btn" data-remove-email="' + escapeAttr(entry.email) + '">Remove</button>' +
      '</div>';
  }).join('');

  list.querySelectorAll('[data-remove-email]').forEach(function(btn) {
    btn.addEventListener('click', function() { handleAdminRemove(btn.dataset.removeEmail); });
  });

  list.querySelectorAll('[data-edit-email]').forEach(function(btn) {
    btn.addEventListener('click', function() { handleAdminEdit(btn.dataset.editEmail); });
  });

  list.querySelectorAll('[data-resend-email]').forEach(function(btn) {
    btn.addEventListener('click', function() { handleAdminResend(btn.dataset.resendEmail, btn); });
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
    showToast('Email is required.', 'error');
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Enter a valid email address.', 'error');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  var payload = {
    email:     email,
    circles:   circles,
    invitedBy: state.user.uid,
    updatedAt: serverTimestamp()
  };

  setDoc(doc(db, 'allowlist', email), payload, { merge: true }).then(function() {
    return syncUserDocsForAllowlist(email, circles);
  }).then(function() {
    return queueInviteEmail(email, circles);
  }).then(function() {
    emailEl.value = '';
    setCheckedCircles('#adminInviteCircles', []);
    showToast('Invite saved and email queued.', 'success');
    return loadAllowlistMembers();
  }).catch(function(err) {
    logError('Failed to save allowlist entry', err);
    showToast('Failed to save invite or queue the email. Check console for details.', 'error');
  }).finally(function() {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Invite';
  });
};

var handleAdminRemove = function(email) {
  if (!state.isAdmin || !email) return;

  showConfirmModal('Remove invite', 'Remove ' + email + ' from the allowlist?', 'Remove').then(function(confirmed) {
    if (!confirmed) return;

    deleteDoc(doc(db, 'allowlist', email)).then(function() {
      return syncUserDocsForAllowlist(email, []);
    }).then(function() {
      adminState.allowlist = adminState.allowlist.filter(function(entry) {
        return entry.email !== email;
      });
      renderAllowlistMembers();
      showToast('Invite removed.', 'success');
    }).catch(function(err) {
      logError('Failed to remove allowlist entry', err);
      showToast('Failed to remove invite. Check console for details.', 'error');
    });
  });
};

// ─── Admin: edit circles ──────────────────────────────────────────────────────
var handleAdminEdit = function(email) {
  if (!state.isAdmin || !email) return;

  var entry = adminState.allowlist.find(function(e) { return e.email === email; });
  if (!entry) return;

  showCirclePickerModal({
    title: 'Edit circles',
    message: email,
    initialCircles: entry.circles,
    confirmLabel: 'Save'
  }).then(function(newCircles) {
    if (newCircles === null) return;

    var old = entry.circles;
    if (newCircles.length === old.length && newCircles.every(function(c) { return old.indexOf(c) !== -1; })) return;

    setDoc(doc(db, 'allowlist', email), { circles: newCircles, updatedAt: serverTimestamp() }, { merge: true }).then(function() {
      return syncUserDocsForAllowlist(email, newCircles);
    }).then(function() {
      return loadAllowlistMembers();
    }).then(function() {
      showToast('Circles updated.', 'success');
    }).catch(function(err) {
      logError('Failed to update circles', err);
      showToast('Failed to update circles. Check console for details.', 'error');
    });
  });
};

// ─── Admin: resend invite ─────────────────────────────────────────────────────
var handleAdminResend = function(email, btn) {
  if (!state.isAdmin || !email) return;
  if (btn && btn.disabled) return;

  var entry = adminState.allowlist.find(function(e) { return e.email === email; });
  if (!entry) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

  queueInviteEmail(email, entry.circles).then(function() {
    showToast('Invite email resent.', 'success');
  }).catch(function(err) {
    logError('Failed to resend invite', err);
    showToast('Failed to resend invite. Check console for details.', 'error');
  }).finally(function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Resend'; }
  });
};

// ─── Admin: bulk invite ───────────────────────────────────────────────────────
var handleAdminBulkInvite = function() {
  if (!state.isAdmin || !state.user) return;

  var textarea = document.getElementById('adminBulkEmails');
  var btn = document.getElementById('adminBulkInviteBtn');
  var results = document.getElementById('adminBulkResults');
  if (!textarea || !btn || !results) return;

  var tokens = textarea.value.split(/[\s,;]+/).map(function(t) { return t.trim().toLowerCase(); }).filter(Boolean)
    .filter(function(e, i, a) { return a.indexOf(e) === i; });

  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var valid = [], invalid = [];
  tokens.forEach(function(t) { (emailRegex.test(t) ? valid : invalid).push(t); });

  var circles = getCheckedCircles('#adminBulkCircles');

  if (valid.length === 0 && invalid.length === 0) {
    showToast('Enter at least one email address.', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending...';
  results.innerHTML = '';

  var succeeded = 0;
  var failed = [];

  var finish = function() {
    btn.disabled = false;
    btn.textContent = 'Send Invites';
    var s = 'Sent ' + succeeded + ' invite' + (succeeded !== 1 ? 's' : '') + '.';
    if (invalid.length) { s += ' ' + invalid.length + ' invalid email' + (invalid.length !== 1 ? 's' : '') + ' skipped.'; }
    if (failed.length)  { s += ' ' + failed.length + ' failed.'; }
    var toList = function(arr) { return '<ul>' + arr.map(function(e) { return '<li>' + escapeHTML(e) + '</li>'; }).join('') + '</ul>'; };
    results.innerHTML = '<p>' + escapeHTML(s) + '</p>' +
      (invalid.length ? toList(invalid) : '') +
      (failed.length  ? toList(failed)  : '');
    if (succeeded > 0) { textarea.value = ''; setCheckedCircles('#adminBulkCircles', []); loadAllowlistMembers(); }
  };

  var processNext = function(i) {
    if (i >= valid.length) { finish(); return; }

    var email = valid[i];

    setDoc(doc(db, 'allowlist', email), { email: email, circles: circles, invitedBy: state.user.uid, updatedAt: serverTimestamp() }, { merge: true }).then(function() {
      return syncUserDocsForAllowlist(email, circles);
    }).then(function() {
      return queueInviteEmail(email, circles);
    }).then(function() {
      succeeded++;
      processNext(i + 1);
    }).catch(function(err) {
      logError('Failed to bulk invite ' + email, err);
      failed.push(email);
      processNext(i + 1);
    });
  };

  processNext(0);
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
          btn.hidden = getVisibleCircles(state).indexOf(btn.dataset.circle) === -1;
        });
        syncSidebarSelection();
        loadPanelCircles();
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

var queueInviteEmail = function(email, circles) {
  var inviteURL = getAppURL();
  var inviterName = (state.user && (state.user.displayName || state.user.email)) || 'Enclave Admin';
  var circleNames = normalizeCircles(circles).map(circleLabel);
  var circleLine = circleNames.length > 0
    ? circleNames.join(', ')
    : 'No circles assigned yet';
  var htmlList = circleNames.length > 0
    ? '<ul>' + circleNames.map(function(name) {
      return '<li>' + escapeHTML(name) + '</li>';
    }).join('') + '</ul>'
    : '<p>No circles assigned yet.</p>';

  return addDoc(collection(db, 'mail'), {
    to: [email],
    createdAt: serverTimestamp(),
    metadata: {
      type: 'invite',
      invitedEmail: email,
      invitedBy: state.user ? state.user.uid : '',
      circles: normalizeCircles(circles)
    },
    message: {
      subject: 'You are invited to Enclave',
      text:
        'You have been invited to Enclave by ' + inviterName + '.\n\n' +
        'Assigned circles: ' + circleLine + '\n\n' +
        'Open Enclave here:\n' + inviteURL + '\n\n' +
        'Sign in with this same Google account: ' + email + '\n',
      html:
        '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">' +
          '<h2>You are invited to Enclave</h2>' +
          '<p><strong>' + escapeHTML(inviterName) + '</strong> invited you to join Enclave.</p>' +
          '<p><strong>Assigned circles:</strong></p>' +
          htmlList +
          '<p><a href="' + escapeAttr(inviteURL) + '">Open Enclave</a></p>' +
          '<p>Sign in with this same Google account: <strong>' + escapeHTML(email) + '</strong></p>' +
        '</div>'
    }
  });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
var setCheckedCircles = function(containerSelector, circles) {
  var normalized = normalizeCircles(circles);

  document.querySelectorAll(containerSelector + ' input[type="checkbox"]').forEach(function(cb) {
    cb.checked = normalized.indexOf(cb.value) !== -1;
  });
};
