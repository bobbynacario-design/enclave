// Circles page — start a circle, choose who's in it, leave or delete it.
// Every change goes through the `circles` Cloud Function (circles-api.js),
// which keeps each member's two copies of their circle list in step; this
// page only reads.

import {
  collection,
  getDocs
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { db } from '../../firebase.js';

import { state, circlesState } from '../state.js';

import { escapeHTML, escapeAttr } from '../util/escape.js';

import {
  getCircle,
  circleLabel,
  listVisibleCircles,
  isLegacyCircle,
  getInitials
} from '../util/circles.js';

import { LEGACY_CIRCLES } from '../util/constants.js';

import { circlesAction, circlesErrorMessage } from '../util/circles-api.js';

import { logError } from '../util/log.js';

import { showToast } from '../ui/toast.js';

import { showConfirmModal } from '../ui/modals.js';

import { refreshCircles } from '../util/shell-bridge.js';

// Every member's user doc, to list who is in each circle. Enclave is small
// enough that one read beats a query per circle.
var people = [];
var renamingId = '';

// ─── Circles: init ────────────────────────────────────────────────────────────
export const initCirclesPage = function() {
  var newBtn    = document.getElementById('circlesNewBtn');
  var cancelBtn = document.getElementById('circlesCreateCancel');
  var saveBtn   = document.getElementById('circlesCreateSave');
  var nameEl    = document.getElementById('circlesCreateName');
  var list      = document.getElementById('circlesList');

  if (newBtn) newBtn.addEventListener('click', openCreateForm);
  if (cancelBtn) cancelBtn.addEventListener('click', closeCreateForm);
  if (saveBtn) saveBtn.addEventListener('click', handleCreate);
  if (nameEl) {
    nameEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreate();
      }
    });
  }

  if (list) {
    list.addEventListener('click', handleListClick);
    list.addEventListener('submit', handleListSubmit);
  }

  if (circlesState.openCreate) {
    circlesState.openCreate = false;
    openCreateForm();
  }

  renamingId = '';
  loadPeople();
};

var loadPeople = function() {
  getDocs(collection(db, 'users')).then(function(snap) {
    people = snap.docs.map(function(d) {
      return Object.assign({ uid: d.id }, d.data());
    });
    renderCircles();
  }).catch(function(err) {
    logError('Failed to load circle members', err);
    people = [];
    renderCircles();
  });
};

// ─── Create ───────────────────────────────────────────────────────────────────
var openCreateForm = function() {
  var form = document.getElementById('circlesCreate');
  var nameEl = document.getElementById('circlesCreateName');
  if (!form) return;
  form.hidden = false;
  if (nameEl) nameEl.focus();
};

var closeCreateForm = function() {
  var form = document.getElementById('circlesCreate');
  var nameEl = document.getElementById('circlesCreateName');
  if (form) form.hidden = true;
  if (nameEl) nameEl.value = '';
};

var handleCreate = function() {
  var nameEl = document.getElementById('circlesCreateName');
  var saveBtn = document.getElementById('circlesCreateSave');
  if (!nameEl || !saveBtn || saveBtn.disabled) return;

  var name = nameEl.value.trim();
  if (!name) {
    showToast('Give the circle a name.', 'error');
    nameEl.focus();
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Creating...';

  circlesAction('create', { name: name }).then(function(result) {
    // The users-doc listener would catch this too; adding it now means the
    // new circle shows without waiting for it.
    if (result.id && state.circles.indexOf(result.id) === -1) {
      state.circles = state.circles.concat([result.id]);
    }
    showToast('Created "' + (result.name || name) + '". Add people by email below.', 'success');
    return refreshCircles();
  }).catch(function(err) {
    logError('Failed to create circle', err);
    showToast(circlesErrorMessage(err), 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Create Circle';
  });
};

// ─── Render ───────────────────────────────────────────────────────────────────
var renderCircles = function() {
  var list = document.getElementById('circlesList');
  if (!list) return;

  renderSetupNotice();

  var ids = listVisibleCircles(state).filter(function(id) {
    return !!getCircle(id) || isLegacyCircle(id);
  });

  if (!ids.length) {
    list.innerHTML = '' +
      '<div class="card empty-state">' +
        '<div class="empty-state-title">No circles yet</div>' +
        '<p class="empty-state-text">Start one for your family, a group of friends or a team, then add people by email.</p>' +
      '</div>';
    return;
  }

  list.innerHTML = ids.map(renderCircleCard).join('');
};

// The three original circles predate circle records. Until an admin runs the
// one-time setup they can't be managed here (everyone keeps their access).
var renderSetupNotice = function() {
  var el = document.getElementById('circlesSetup');
  if (!el) return;

  var missing = LEGACY_CIRCLES.some(function(c) { return !getCircle(c.id); });
  if (!state.isAdmin || !missing) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = '' +
    '<div class="card circles-setup">' +
      '<div>' +
        '<div class="circles-setup-title">Bring in the original circles</div>' +
        '<p class="text-muted">Hustle Hub, Work Network and Family were set up before members could start their own circles. ' +
          'A one-time step adds them here, looked after by you, so you can add people and rename them like any other circle. ' +
          'Nobody\'s access changes.</p>' +
      '</div>' +
      '<button class="btn btn-primary" type="button" id="circlesSetupBtn">Set up</button>' +
    '</div>';

  var btn = document.getElementById('circlesSetupBtn');
  if (btn) btn.addEventListener('click', function() { handleSetup(btn); });
};

var membersOf = function(circleId) {
  return people.filter(function(p) {
    return Array.isArray(p.circles) && p.circles.indexOf(circleId) !== -1;
  }).sort(function(a, b) {
    return String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''));
  });
};

var personName = function(person) {
  return person.name || person.displayName || person.email || 'Member';
};

var renderAvatar = function(person) {
  if (person && person.photoURL) {
    return '<span class="circle-person-avatar" style="background-image:url(' + escapeAttr(person.photoURL) + ')"></span>';
  }
  return '<span class="circle-person-avatar">' + escapeHTML(getInitials(person ? personName(person) : '')) + '</span>';
};

var actionButton = function(action, circleId, label, extra) {
  return '<button class="btn btn-ghost" type="button" data-circle-action="' + action + '" ' +
    'data-circle-id="' + escapeAttr(circleId) + '"' + (extra || '') + '>' + label + '</button>';
};

var renderCircleCard = function(circleId) {
  var circle  = getCircle(circleId);
  var name    = circleLabel(circleId);
  var myUid   = state.user ? state.user.uid : '';
  var legacy  = isLegacyCircle(circleId);
  var inside  = state.circles.indexOf(circleId) !== -1;
  var isOwner = !!circle && circle.ownerId === myUid;
  var members = membersOf(circleId);

  var memberEmails = members.map(function(p) { return String(p.email || '').toLowerCase(); });
  var pending = (circle && Array.isArray(circle.invitedEmails) ? circle.invitedEmails : [])
    .filter(function(email) { return memberEmails.indexOf(email) === -1; });

  var owner = circle ? people.find(function(p) { return p.uid === circle.ownerId; }) : null;
  var ownerName = owner ? personName(owner) : (circle && circle.ownerName) || '';

  var metaParts = [members.length === 1 ? '1 person' : members.length + ' people'];
  if (pending.length) metaParts.push(pending.length + ' invited');
  if (!circle) {
    metaParts.push(state.isAdmin ? 'Needs the one-time setup above' : 'One of the original circles');
  } else if (isOwner) {
    metaParts.push('You look after this circle');
  } else if (ownerName) {
    metaParts.push('Looked after by ' + ownerName);
  }
  if (!inside) metaParts.push('You can see it as an admin');

  var titleHTML = renamingId === circleId && isOwner
    ? '<form class="circle-rename" data-rename-form="' + escapeAttr(circleId) + '">' +
        '<label class="sr-only" for="circleRename-' + escapeAttr(circleId) + '">Circle name</label>' +
        '<input type="text" class="edit-input" id="circleRename-' + escapeAttr(circleId) + '" maxlength="40" value="' + escapeAttr(name) + '" />' +
        '<button class="btn btn-primary" type="submit">Save</button>' +
        actionButton('cancel-rename', circleId, 'Cancel') +
      '</form>'
    : '<h2 class="circle-card-title">' + escapeHTML(name) + '</h2>';

  // Owners of a member circle can leave only if someone else can take it
  // over; on their own, Delete is the way out. The original circles stay
  // with the admin who owns them.
  var canLeave = !!circle && inside && (!isOwner || (!legacy && members.length > 1));
  var actions = actionButton('open', circleId, 'Open feed');
  if (isOwner && renamingId !== circleId) actions += actionButton('rename', circleId, 'Rename');
  if (canLeave) actions += actionButton('leave', circleId, 'Leave');
  if (isOwner && !legacy) actions += actionButton('delete', circleId, 'Delete', ' data-danger');

  var peopleHTML = members.map(function(person) {
    var tags = '';
    if (circle && person.uid === circle.ownerId) tags += '<span class="circle-tag">Looks after it</span>';
    var you = person.uid === myUid ? ' <span class="text-muted">(you)</span>' : '';
    var remove = isOwner && person.uid !== myUid
      ? '<button class="btn btn-ghost circle-person-btn" type="button" data-circle-action="remove" ' +
          'data-circle-id="' + escapeAttr(circleId) + '" data-uid="' + escapeAttr(person.uid) + '" ' +
          'data-name="' + escapeAttr(personName(person)) + '">Remove</button>'
      : '';
    return '<li class="circle-person">' + renderAvatar(person) +
      '<span class="circle-person-name">' + escapeHTML(personName(person)) + you + '</span>' +
      tags + remove + '</li>';
  }).join('') + pending.map(function(email) {
    var cancel = isOwner
      ? '<button class="btn btn-ghost circle-person-btn" type="button" data-circle-action="cancel-invite" ' +
          'data-circle-id="' + escapeAttr(circleId) + '" data-email="' + escapeAttr(email) + '">Cancel invite</button>'
      : '';
    return '<li class="circle-person circle-person-pending">' +
      '<span class="circle-person-avatar" aria-hidden="true">&#9993;</span>' +
      '<span class="circle-person-name">' + escapeHTML(email) + '</span>' +
      '<span class="circle-tag circle-tag-empty">Invited</span>' + cancel + '</li>';
  }).join('');

  var inviteHTML = isOwner
    ? '<form class="circle-invite" data-invite-form="' + escapeAttr(circleId) + '">' +
        '<label class="sr-only" for="circleInvite-' + escapeAttr(circleId) + '">Add people by email</label>' +
        '<input type="text" class="edit-input" id="circleInvite-' + escapeAttr(circleId) + '" ' +
          'placeholder="Add people by email" autocomplete="off" inputmode="email" />' +
        '<button class="btn btn-primary" type="submit">Add</button>' +
      '</form>' +
      '<p class="form-help">People already on Enclave are added straight away. Anyone else gets an email inviting them to join. ' +
        'They\'ll see this circle and anything posted to All members, not your other circles.</p>'
    : '';

  return '' +
    '<section class="card circle-card" data-circle-card="' + escapeAttr(circleId) + '">' +
      '<div class="circle-card-head">' +
        '<div class="circle-card-heading">' +
          titleHTML +
          '<p class="circle-card-meta">' + escapeHTML(metaParts.join(' · ')) + '</p>' +
        '</div>' +
        '<div class="circle-card-actions">' + actions + '</div>' +
      '</div>' +
      (peopleHTML ? '<ul class="circle-people">' + peopleHTML + '</ul>' : '') +
      inviteHTML +
    '</section>';
};

// ─── Actions ──────────────────────────────────────────────────────────────────
var dropCircleLocally = function(circleId) {
  state.circles = state.circles.filter(function(id) { return id !== circleId; });
};

// Runs one circle action with its button showing progress. On success the
// page is redrawn from fresh data, so the button needs no reset.
var runAction = function(btn, busyLabel, action, data, successMessage) {
  var label = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = busyLabel;
  }

  return circlesAction(action, data).then(function(result) {
    // Leaving or deleting takes the circle off this person's list now,
    // before the users-doc listener catches up.
    if (action === 'leave' || action === 'delete') dropCircleLocally(data.circleId);
    var message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
    if (message) showToast(message, 'success');
    return refreshCircles().then(function() { return result; });
  }).catch(function(err) {
    logError('Circle action failed: ' + action, err);
    showToast(circlesErrorMessage(err), 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
    return null;
  });
};

var handleListClick = function(e) {
  var btn = e.target.closest('[data-circle-action]');
  if (!btn || btn.disabled) return;

  var circleId = btn.dataset.circleId;
  var name = circleLabel(circleId);
  var action = btn.dataset.circleAction;

  if (action === 'open') {
    window.enclaveGoCircle(circleId);
    return;
  }

  if (action === 'rename') {
    renamingId = circleId;
    renderCircles();
    var input = document.getElementById('circleRename-' + circleId);
    if (input) {
      input.focus();
      input.select();
    }
    return;
  }

  if (action === 'cancel-rename') {
    renamingId = '';
    renderCircles();
    return;
  }

  if (action === 'leave') {
    var circle = getCircle(circleId);
    var isOwner = circle && state.user && circle.ownerId === state.user.uid;
    var message = isOwner
      ? 'Leave "' + name + '"? You\'ll stop seeing what\'s shared there, and whoever has been in it longest will look after it.'
      : 'Leave "' + name + '"? You\'ll stop seeing what\'s shared there. Only the person who looks after it can add you back.';
    showConfirmModal('Leave circle', message, 'Leave').then(function(confirmed) {
      if (!confirmed) return;
      runAction(btn, 'Leaving...', 'leave', { circleId: circleId }, 'You left "' + name + '".');
    });
    return;
  }

  if (action === 'delete') {
    showConfirmModal('Delete circle',
      'Delete "' + name + '"? Everything posted to it is deleted for everyone in it. This can\'t be undone.',
      'Delete').then(function(confirmed) {
      if (!confirmed) return;
      runAction(btn, 'Deleting...', 'delete', { circleId: circleId }, 'Deleted "' + name + '".');
    });
    return;
  }

  if (action === 'remove') {
    var personLabel = btn.dataset.name || 'them';
    showConfirmModal('Remove from circle',
      'Remove ' + personLabel + ' from "' + name + '"? They\'ll stop seeing what\'s shared there.',
      'Remove').then(function(confirmed) {
      if (!confirmed) return;
      runAction(btn, 'Removing...', 'remove', { circleId: circleId, uid: btn.dataset.uid },
        'Removed ' + personLabel + '.');
    });
    return;
  }

  if (action === 'cancel-invite') {
    runAction(btn, 'Cancelling...', 'remove', { circleId: circleId, email: btn.dataset.email },
      'Invite cancelled.');
  }
};

var handleListSubmit = function(e) {
  var renameForm = e.target.closest('[data-rename-form]');
  var inviteForm = e.target.closest('[data-invite-form]');
  if (!renameForm && !inviteForm) return;
  e.preventDefault();

  var form = renameForm || inviteForm;
  var input = form.querySelector('input');
  var submit = form.querySelector('button[type="submit"]');
  if (!input || !submit || submit.disabled) return;

  if (renameForm) {
    var circleId = renameForm.dataset.renameForm;
    var name = input.value.trim();
    if (!name) {
      showToast('Give the circle a name.', 'error');
      return;
    }
    if (name === circleLabel(circleId)) {
      renamingId = '';
      renderCircles();
      return;
    }
    runAction(submit, 'Saving...', 'rename', { circleId: circleId, name: name }, 'Renamed.').then(function(result) {
      if (result) renamingId = '';
    });
    return;
  }

  var emails = input.value.split(/[\s,;]+/).map(function(t) { return t.trim(); }).filter(Boolean);
  if (!emails.length) {
    showToast('Enter an email address.', 'error');
    input.focus();
    return;
  }

  runAction(submit, 'Adding...', 'invite', { circleId: inviteForm.dataset.inviteForm, emails: emails },
    describeInviteResults);
};

// One line per outcome, e.g. "Added 1. Invited 2 by email. a@b.com is
// already in this circle."
var describeInviteResults = function(result) {
  var rows = (result && result.results) || [];
  var added = rows.filter(function(r) { return r.status === 'added'; }).length;
  var invited = rows.filter(function(r) { return r.status === 'invited'; }).length;
  var notes = [];

  if (added) notes.push('Added ' + added + '.');
  if (invited) notes.push('Invited ' + invited + ' by email.');

  rows.forEach(function(r) {
    if (r.status === 'already-member')   notes.push(r.email + ' is already in this circle.');
    if (r.status === 'already-invited')  notes.push(r.email + ' has already been invited.');
    if (r.status === 'invalid')          notes.push(r.email + ' isn\'t an email address.');
    if (r.status === 'too-many-circles') notes.push(r.email + ' is in too many circles to join another.');
    if (r.status === 'not-allowed')      notes.push(r.email + ' was removed from Enclave, so only an admin can bring them back.');
  });

  return notes.join(' ') || 'Nothing to change.';
};

var handleSetup = function(btn) {
  if (!btn || btn.disabled) return;
  runAction(btn, 'Setting up...', 'setup', {}, function(result) {
    return result && result.created
      ? 'The original circles are ready to manage.'
      : 'The original circles were already set up.';
  });
};

