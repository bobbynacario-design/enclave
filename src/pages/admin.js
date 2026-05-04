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
  setDoc,
  onSnapshot
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

import { writeNotification } from './notifications.js';

import {
  syncSidebarSelection,
  loadPage,
  getAppURL,
  loadPanelCircles
} from '../util/shell-bridge.js';

var INACTIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

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

    var now = Date.now();
    var entries = [];
    allowlistSnap.forEach(function(d) {
      var data = d.data() || {};
      var email = (data.email || d.id || '').toLowerCase();
      var userDoc = adminState.usersByEmail[email];
      var pending = !userDoc;
      var inactive = false;
      var lastSeenMs = 0;

      if (!pending && userDoc.lastSeen) {
        if (typeof userDoc.lastSeen.toMillis === 'function') {
          lastSeenMs = userDoc.lastSeen.toMillis();
        } else if (typeof userDoc.lastSeen.toDate === 'function') {
          lastSeenMs = userDoc.lastSeen.toDate().getTime();
        }
        if (lastSeenMs > 0 && (now - lastSeenMs) > INACTIVE_THRESHOLD_MS) {
          inactive = true;
        }
      }

      entries.push({
        email:      email,
        circles:    normalizeCircles(data.circles),
        pending:    pending,
        inactive:   inactive,
        uid:        userDoc ? (userDoc.uid || '') : '',
        name:       userDoc ? (userDoc.name || userDoc.displayName || '') : '',
        lastSeenMs: lastSeenMs
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
      ? '<span class="circle-tag circle-tag-empty">Not joined</span>'
      : '';

    var inactiveBadge = entry.inactive
      ? '<span class="circle-tag admin-inactive-badge">Inactive</span>'
      : '';

    var resendBtn = entry.pending
      ? '<button class="btn btn-ghost" data-resend-email="' + escapeAttr(entry.email) + '">Resend</button>'
      : '';

    var nudgeBtn = entry.inactive
      ? '<button class="btn btn-ghost" data-nudge-email="' + escapeAttr(entry.email) + '">Nudge</button>'
      : '';

    return '' +
      '<div class="card admin-member-row">' +
        '<div class="admin-member-meta">' +
          '<div class="admin-member-email">' + escapeHTML(entry.email) + '</div>' +
          '<div class="member-circles">' + circleTags + pendingBadge + inactiveBadge + '</div>' +
        '</div>' +
        resendBtn +
        nudgeBtn +
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

  list.querySelectorAll('[data-nudge-email]').forEach(function(btn) {
    btn.addEventListener('click', function() { handleAdminNudge(btn.dataset.nudgeEmail, btn); });
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
    showToast('Invite saved. Email queued — delivery may take a minute.', 'success');
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

  showActionModal('resend', email, entry.name).then(function(result) {
    if (!result) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

    queueInviteEmail(email, entry.circles, result.message).then(function(mailRef) {
      showToast('Invite queued. Checking delivery...', 'info');
      return waitForDelivery(mailRef, 30000);
    }).then(function(deliveryResult) {
      if (deliveryResult.state === 'SUCCESS') {
        showToast('Invite sent to ' + email + '.', 'success');
      } else if (deliveryResult.state === 'ERROR') {
        showToast('Delivery failed: ' + (deliveryResult.error || 'unknown error'), 'error');
      } else if (deliveryResult.state === 'RETRY') {
        showToast('Delivery is retrying. Check back in a few minutes.', 'info');
      } else {
        showToast('Still sending — delivery may take a minute.', 'info');
      }
    }).catch(function(err) {
      logError('Failed to resend invite', err);
      showToast('Failed to resend invite. Check console for details.', 'error');
    }).finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Resend'; }
    });
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

// ─── Admin: action modal (nudge + resend) ─────────────────────────────────────
var showActionModal = function(mode, email, name) {
  // mode: 'nudge' or 'resend'
  return new Promise(function(resolve) {
    var existing = document.getElementById('dialogBackdrop');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    var displayName = name || email.split('@')[0] || 'there';
    var titleText, subtitleText, defaultMessage, sendBtnLabel, showNotifOption, lockEmail;

    if (mode === 'resend') {
      titleText      = 'Resend invite to ' + (name || email);
      subtitleText   = 'Re-send the invite email. Add a personal message if you want.';
      defaultMessage = 'Hi ' + displayName + ', here\'s your Enclave invite again — looking forward to having you!';
      sendBtnLabel   = 'Resend Invite';
      showNotifOption = false;
      lockEmail      = true;
    } else {
      titleText      = 'Nudge ' + (name || email);
      subtitleText   = 'Send a friendly reminder by email and in-app notification.';
      defaultMessage = 'Hi ' + displayName + ', it\'s been a while! ' +
        'There\'s been activity in Enclave — come check it out.';
      sendBtnLabel   = 'Send Nudge';
      showNotifOption = true;
      lockEmail      = false;
    }

    var backdrop   = document.createElement('div');
    var card       = document.createElement('div');
    var title      = document.createElement('div');
    var subtitle   = document.createElement('div');
    var label      = document.createElement('label');
    var textarea   = document.createElement('textarea');
    var optionsRow = document.createElement('div');
    var emailLabel = document.createElement('label');
    var emailCheck = document.createElement('input');
    var emailText  = document.createElement('span');
    var actions    = document.createElement('div');
    var cancelBtn  = document.createElement('button');
    var sendBtn    = document.createElement('button');

    backdrop.id        = 'dialogBackdrop';
    backdrop.className = 'dialog-backdrop';

    card.className = 'dialog-card';

    title.className   = 'dialog-title';
    title.textContent = titleText;

    subtitle.className   = 'dialog-message';
    subtitle.textContent = subtitleText;

    label.className   = 'profile-section-title';
    label.textContent = 'Personal message';
    label.htmlFor     = 'actionMessage';

    textarea.id        = 'actionMessage';
    textarea.className = 'edit-input edit-textarea';
    textarea.rows      = 4;
    textarea.maxLength = 500;
    textarea.value     = defaultMessage;

    optionsRow.className = 'admin-nudge-options';

    emailCheck.type    = 'checkbox';
    emailCheck.id      = 'actionSendEmail';
    emailCheck.checked = true;
    if (lockEmail) { emailCheck.disabled = true; }
    emailText.textContent = 'Send email';
    emailLabel.appendChild(emailCheck);
    emailLabel.appendChild(emailText);
    emailLabel.className = 'admin-nudge-option';
    optionsRow.appendChild(emailLabel);

    var notifCheck = null;
    if (showNotifOption) {
      var notifLabel = document.createElement('label');
      notifCheck     = document.createElement('input');
      var notifText  = document.createElement('span');

      notifCheck.type    = 'checkbox';
      notifCheck.id      = 'actionSendNotif';
      notifCheck.checked = true;
      notifText.textContent = 'Send in-app notification';
      notifLabel.appendChild(notifCheck);
      notifLabel.appendChild(notifText);
      notifLabel.className = 'admin-nudge-option';
      optionsRow.appendChild(notifLabel);
    }

    actions.className = 'dialog-actions';

    cancelBtn.type      = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancel';

    sendBtn.type      = 'button';
    sendBtn.className = 'btn btn-primary';
    sendBtn.textContent = sendBtnLabel;

    var close = function(result) {
      if (backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
      resolve(result);
    };

    cancelBtn.addEventListener('click', function() { close(null); });

    sendBtn.addEventListener('click', function() {
      var message = textarea.value.trim();
      if (!message) {
        showToast('Message is required.', 'error');
        return;
      }
      close({
        message:   message,
        sendEmail: emailCheck.checked,
        sendNotif: notifCheck ? notifCheck.checked : false
      });
    });

    backdrop.addEventListener('click', function(e) {
      if (e.target === backdrop) { close(null); }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(sendBtn);

    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(label);
    card.appendChild(textarea);
    card.appendChild(optionsRow);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    textarea.focus();
    textarea.select();
  });
};

var queueNudgeEmail = function(email, name, message) {
  var inviteURL   = getAppURL();
  var inviterName = (state.user && (state.user.displayName || state.user.email)) || 'Enclave Admin';
  var displayName = name || email.split('@')[0] || 'there';
  var subject     = inviterName + ' reminded you about Enclave';

  var html =
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f5f5f7">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">' +
    '<tr><td bgcolor="#7c5cbf" style="padding:24px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="vertical-align:middle;">' +
    '<img src="https://bobbynacario-design.github.io/enclave/icon-192.png" width="56" height="56" alt="Enclave" style="display:block;border:0;border-radius:12px;">' +
    '</td>' +
    '<td style="vertical-align:middle;padding-left:16px;">' +
    '<span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:600;color:#ffffff;">Enclave</span>' +
    '</td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:40px 32px 24px;">' +
    '<h1 style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:600;color:#1a1a1a;margin:0 0 8px 0;">Hey ' + escapeHTML(displayName) + '</h1>' +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-style:italic;color:#6b6b6b;margin:0;">A quick note from ' + escapeHTML(inviterName) + '.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:0 32px 24px;">' +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#1a1a1a;line-height:1.6;margin:0;white-space:pre-wrap;">' + escapeHTML(message) + '</p>' +
    '</td></tr>' +
    renderEmailInstallBlock() +
    '<tr><td style="padding:8px 32px 32px;" align="center">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td bgcolor="#7c5cbf" style="border-radius:8px;">' +
    '<a href="' + escapeAttr(inviteURL) + '" target="_blank" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Open Enclave</a>' +
    '</td></tr></table>' +
    '</td></tr>' +
    '<tr><td style="border-top:1px solid #e5e5e5;padding:24px 32px;">' +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b6b6b;line-height:1.5;text-align:center;margin:0;">You received this because you are a member of Enclave.</p>' +
    '</td></tr>' +
    '</table></td></tr></table>';

  var text =
    'Hey ' + displayName + ',\n\n' +
    message + '\n\n' +
    'Open Enclave: ' + inviteURL + '\n\n' +
    '— ' + inviterName;
  text += renderTextInstallBlock();

  return addDoc(collection(db, 'mail'), {
    to: [email],
    createdAt: serverTimestamp(),
    metadata: {
      type:        'nudge',
      nudgedEmail: email,
      nudgedBy:    state.user ? state.user.uid : ''
    },
    message: {
      subject: subject,
      text:    text,
      html:    html
    }
  });
};

var handleAdminNudge = function(email, btn) {
  if (!state.isAdmin || !email) return;
  if (btn && btn.disabled) return;

  var entry = adminState.allowlist.find(function(e) { return e.email === email; });
  if (!entry) return;

  showActionModal('nudge', email, entry.name).then(function(result) {
    if (!result) return;
    if (!result.sendEmail && !result.sendNotif) {
      showToast('Pick at least one delivery method.', 'error');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

    var tasks = [];

    if (result.sendEmail) {
      tasks.push(queueNudgeEmail(email, entry.name, result.message));
    }

    if (result.sendNotif && entry.uid) {
      var actor = (state.user && (state.user.displayName || state.user.email)) || 'Enclave Admin';
      tasks.push(writeNotification(entry.uid, 'nudge', result.message, {
        page:   'feed',
        params: {}
      }));
    }

    Promise.all(tasks).then(function() {
      showToast('Nudge sent.', 'success');
    }).catch(function(err) {
      logError('Failed to send nudge', err);
      showToast('Nudge partially failed. Check console for details.', 'error');
    }).finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Nudge'; }
    });
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

var renderEmailInstallBlock = function() {
  return '' +
    '<tr><td style="padding:0 32px 8px;">' +
      '<p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:600;color:#1a1a1a;margin:0 0 8px 0;">' +
        'Install Enclave for quick access' +
      '</p>' +
      '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6b6b6b;margin:0 0 18px 0;line-height:1.55;">' +
        'Once installed, Enclave opens like a real app — no browser tabs, full-screen, faster to come back to.' +
      '</p>' +
    '</td></tr>' +
    '<tr><td style="padding:0 32px 14px;">' +
      '<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#7c5cbf;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.04em;">' +
        'iPhone / iPad (Safari)' +
      '</p>' +
      '<ol style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;margin:0;padding-left:20px;line-height:1.6;">' +
        '<li>Tap the Share button (square with an up-arrow)</li>' +
        '<li>Tap "Add to Home Screen"</li>' +
        '<li>Tap "Add"</li>' +
      '</ol>' +
    '</td></tr>' +
    '<tr><td style="padding:0 32px 14px;">' +
      '<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#7c5cbf;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.04em;">' +
        'Android (Chrome)' +
      '</p>' +
      '<ol style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;margin:0;padding-left:20px;line-height:1.6;">' +
        '<li>Tap the three-dot menu</li>' +
        '<li>Tap "Install app" or "Add to Home screen"</li>' +
        '<li>Tap "Install"</li>' +
      '</ol>' +
    '</td></tr>' +
    '<tr><td style="padding:0 32px 24px;">' +
      '<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:#7c5cbf;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.04em;">' +
        'Desktop (Chrome / Edge)' +
      '</p>' +
      '<ol style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;margin:0;padding-left:20px;line-height:1.6;">' +
        '<li>Click the install icon in the address bar (small monitor with arrow)</li>' +
        '<li>Or open the three-dot menu and choose "Install Enclave"</li>' +
        '<li>Click "Install"</li>' +
      '</ol>' +
    '</td></tr>';
};

var renderTextInstallBlock = function() {
  return '\n\n' +
    'INSTALL ENCLAVE FOR QUICK ACCESS\n' +
    '--------------------------------\n' +
    'Once installed, Enclave opens like a real app — no browser tabs, full-screen.\n\n' +
    'iPhone / iPad (Safari):\n' +
    '  1. Tap the Share button\n' +
    '  2. Tap "Add to Home Screen"\n' +
    '  3. Tap "Add"\n\n' +
    'Android (Chrome):\n' +
    '  1. Tap the three-dot menu\n' +
    '  2. Tap "Install app" or "Add to Home screen"\n' +
    '  3. Tap "Install"\n\n' +
    'Desktop (Chrome / Edge):\n' +
    '  1. Click the install icon in the address bar\n' +
    '  2. Or three-dot menu → "Install Enclave"\n' +
    '  3. Click "Install"';
};

var renderEmailFeaturesBlock = function() {
  return '' +
    '<tr><td style="padding:0 32px 24px;">' +
      '<p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:600;color:#1a1a1a;margin:0 0 12px 0;">' +
        'What\'s inside' +
      '</p>' +
      '<ul style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;margin:0;padding-left:20px;line-height:1.7;">' +
        '<li><strong>Private feed</strong> in your circles — only invited members see your posts</li>' +
        '<li><strong>Real-time messaging</strong> with anyone in your circles</li>' +
        '<li><strong>Project workspaces</strong> with tasks, files, and comments</li>' +
        '<li><strong>Notifications</strong> when something happens that involves you</li>' +
      '</ul>' +
    '</td></tr>';
};

var renderTextFeaturesBlock = function() {
  return '\n\n' +
    'WHAT\'S INSIDE\n' +
    '-------------\n' +
    '• Private feed in your circles — only invited members see your posts\n' +
    '• Real-time messaging with anyone in your circles\n' +
    '• Project workspaces with tasks, files, and comments\n' +
    '• Notifications when something happens that involves you';
};

var queueInviteEmail = function(email, circles, personalMessage) {
  var inviteURL = getAppURL();
  var inviterName = (state.user && (state.user.displayName || state.user.email)) || 'Enclave Admin';
  var circleNames = normalizeCircles(circles).map(circleLabel);
  var circleLine = circleNames.length > 0
    ? circleNames.join(', ')
    : 'No circles assigned yet';
  var subject = inviterName + ' invited you to Enclave';

  var circlePills = circleNames.length > 0
    ? '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#1a1a1a;margin:0 0 12px 0;">You\'ll have access to these circles:</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      circleNames.map(function(name) {
        return '' +
          '<td bgcolor="#ffffff" style="border:1px solid #d9c8ff;border-radius:16px;padding:6px 12px;white-space:nowrap;">' +
            '<span style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#7c5cbf;">' + escapeHTML(name) + '</span>' +
          '</td><td style="width:8px;"></td>';
      }).join('') +
      '</tr></table>'
    : '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6b6b6b;margin:0;">You\'ll be added to circles soon.</p>';

  var html =
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f5f5f7">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">' +
    '<tr><td bgcolor="#7c5cbf" style="padding:24px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="vertical-align:middle;">' +
    '<img src="https://bobbynacario-design.github.io/enclave/icon-192.png" width="56" height="56" alt="Enclave" style="display:block;border:0;border-radius:12px;">' +
    '</td>' +
    '<td style="vertical-align:middle;padding-left:16px;">' +
    '<span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:600;color:#ffffff;">Enclave</span>' +
    '</td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:40px 32px 24px;">' +
    '<h1 style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:600;color:#1a1a1a;margin:0 0 8px 0;">You\'re invited to Enclave</h1>' +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-style:italic;color:#6b6b6b;margin:0;">Your private space for the people who matter.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:0 32px 24px;">' +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#1a1a1a;line-height:1.6;margin:0;">Hey &#8212; <strong>' + escapeHTML(inviterName) + '</strong> invited you to join Enclave. It\'s a private, invite-only space, and you\'re on the list.</p>' +
    '</td></tr>' +
    (personalMessage
      ? '<tr><td style="padding:0 32px 16px;">' +
          '<div style="background:#f5f0ff;border-left:3px solid #7c5cbf;border-radius:4px;padding:14px 16px;">' +
            '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;margin:0;line-height:1.6;white-space:pre-wrap;">' +
              escapeHTML(personalMessage) +
            '</p>' +
          '</div>' +
        '</td></tr>'
      : '') +
    '<tr><td style="padding:0 32px 32px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f5f0ff" style="border-radius:8px;">' +
    '<tr><td style="padding:20px;">' +
    circlePills +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6b6b6b;line-height:1.5;margin:12px 0 0 0;">Each circle is a private space &#8212; you\'ll only see what people share in circles you\'re part of.</p>' +
    '</td></tr></table>' +
    '</td></tr>' +
    renderEmailFeaturesBlock() +
    renderEmailInstallBlock() +
    '<tr><td style="padding:8px 32px 32px;" align="center">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td bgcolor="#7c5cbf" style="border-radius:8px;">' +
    '<a href="' + escapeAttr(inviteURL) + '" target="_blank" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Open Enclave</a>' +
    '</td></tr></table>' +
    '</td></tr>' +
    '<tr><td style="padding:0 32px 32px;" align="center">' +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#6b6b6b;margin:0 0 4px 0;text-align:center;">Sign in with this Google account:</p>' +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#1a1a1a;margin:0;text-align:center;">' + escapeHTML(email) + '</p>' +
    '</td></tr>' +
    '<tr><td style="border-top:1px solid #e5e5e5;padding:24px 32px;">' +
    '<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b6b6b;line-height:1.5;text-align:center;margin:0;">Enclave is private and invite-only. If you weren\'t expecting this email, you can ignore it.</p>' +
    '</td></tr>' +
    '</table></td></tr></table>';

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
      subject: subject,
      text: (function() {
        var personalNote = personalMessage ? '\n\n' + personalMessage + '\n' : '';
        var t =
          'Hey — ' + inviterName + ' invited you to join Enclave.\n\n' +
          'Enclave is your private space for the people who matter.\n' +
          'It\'s invite-only, and you\'re on the list.' +
          personalNote + '\n\n' +
          'You\'ll have access to these circles:\n' +
          circleLine + '\n\n' +
          'Each circle is a private space — you\'ll only see what people share\n' +
          'in circles you\'re part of.';
        t += renderTextFeaturesBlock();
        t += renderTextInstallBlock();
        t +=
          '\n\n' +
          'Open Enclave: ' + inviteURL + '\n\n' +
          'Sign in with this Google account: ' + email + '\n\n' +
          '—\n\n' +
          'Enclave is private and invite-only. If you weren\'t expecting this\n' +
          'email, you can ignore it.';
        return t;
      }()),
      html: html
    }
  }).then(function(ref) {
    return ref;
  });
};

// ─── Wait for email delivery ──────────────────────────────────────────────────
var waitForDelivery = function(docRef, timeoutMs) {
  return new Promise(function(resolve) {
    var unsubscribe;
    var timer = setTimeout(function() {
      unsubscribe();
      resolve({ state: 'TIMEOUT' });
    }, timeoutMs);

    unsubscribe = onSnapshot(docRef, function(snap) {
      var delivery = snap.exists() ? (snap.data().delivery || null) : null;
      if (!delivery) return;
      var s = delivery.state || '';
      if (s === 'SUCCESS' || s === 'ERROR' || s === 'RETRY') {
        clearTimeout(timer);
        unsubscribe();
        resolve({ state: s, error: delivery.error || null });
      }
    }, function(err) {
      clearTimeout(timer);
      resolve({ state: 'ERROR', error: 'Listener error: ' + (err.message || err.code || 'unknown') });
    });
  });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
var setCheckedCircles = function(containerSelector, circles) {
  var normalized = normalizeCircles(circles);

  document.querySelectorAll(containerSelector + ' input[type="checkbox"]').forEach(function(cb) {
    cb.checked = normalized.indexOf(cb.value) !== -1;
  });
};
