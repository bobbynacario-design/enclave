// First-session onboarding for newly created member records.

import {
  doc,
  updateDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';

import { db } from '../../firebase.js';
import { state } from '../state.js';
import { circleLabel } from '../util/circles.js';
import { escapeHTML, escapeAttr } from '../util/escape.js';
import { logError } from '../util/log.js';
import { loadPage } from '../util/shell-bridge.js';
import { showToast } from './toast.js';
import { wireModalA11y } from './modals.js';

var onboardingTeardown = null;
var onboardingStep = 0;
var onboardingDraft = { role: '', bio: '', destination: 'briefings' };

var renderProgress = function() {
  return [0, 1, 2].map(function(step) {
    var className = step === onboardingStep
      ? 'onboarding-progress-step active'
      : (step < onboardingStep ? 'onboarding-progress-step done' : 'onboarding-progress-step');
    return '<li class="' + className + '"><span>' + (step + 1) + '</span></li>';
  }).join('');
};

var renderCircleTags = function() {
  var circles = Array.isArray(state.circles) ? state.circles : [];
  if (state.isAdmin) {
    circles = ['hustle-hub', 'work-network', 'family'];
  }

  if (!circles.length) {
    return '<p class="onboarding-empty-circles">Your administrator will assign your private circles.</p>';
  }

  return circles.map(function(circle) {
    return '<span class="onboarding-circle-tag">' + escapeHTML(circleLabel(circle)) + '</span>';
  }).join('');
};

var renderDestination = function(id, title, description, recommended) {
  var selected = onboardingDraft.destination === id;
  return '' +
    '<button type="button" class="onboarding-destination' + (selected ? ' selected' : '') + '" ' +
      'data-onboarding-destination="' + id + '" aria-pressed="' + (selected ? 'true' : 'false') + '">' +
      '<span class="onboarding-destination-mark" aria-hidden="true"></span>' +
      '<span><strong>' + escapeHTML(title) + '</strong>' +
      (recommended ? '<em>Recommended</em>' : '') +
      '<small>' + escapeHTML(description) + '</small></span>' +
    '</button>';
};

var stepContent = function() {
  if (onboardingStep === 0) {
    var displayName = state.user && (state.user.displayName || state.user.email) || 'Member';
    var firstName = displayName.indexOf('@') !== -1
      ? displayName.split('@')[0]
      : displayName.split(/\s+/)[0];
    return '' +
      '<div class="onboarding-step-copy">' +
        '<p class="onboarding-eyebrow">Invitation verified</p>' +
        '<h2 id="onboardingTitle">Welcome, ' + escapeHTML(firstName) + '.</h2>' +
        '<p>Your Enclave membership is active. A quick setup will make the network useful from your first visit.</p>' +
      '</div>' +
      '<div class="onboarding-circle-panel">' +
        '<div class="onboarding-section-label">Your private circles</div>' +
        '<div class="onboarding-circle-list">' + renderCircleTags() + '</div>' +
        '<p>You will only see conversations, events, and updates shared with circles you can access.</p>' +
      '</div>';
  }

  if (onboardingStep === 1) {
    return '' +
      '<div class="onboarding-step-copy">' +
        '<p class="onboarding-eyebrow">Complete your profile</p>' +
        '<h2 id="onboardingTitle">Help the network know where you fit.</h2>' +
        '<p>A clear role and short introduction make trusted connections easier.</p>' +
      '</div>' +
      '<div class="onboarding-fields">' +
        '<div>' +
          '<label for="onboardingRole">Role or specialty</label>' +
          '<input class="edit-input" id="onboardingRole" type="text" maxlength="60" required placeholder="e.g. Business interruption consultant" value="' + escapeAttr(onboardingDraft.role) + '" />' +
        '</div>' +
        '<div>' +
          '<label for="onboardingBio">Short introduction <span>Optional</span></label>' +
          '<textarea class="edit-input edit-textarea" id="onboardingBio" rows="4" maxlength="280" placeholder="What do you work on, and how can members collaborate with you?">' + escapeHTML(onboardingDraft.bio) + '</textarea>' +
          '<div class="onboarding-field-help">You can update this later from your member profile.</div>' +
        '</div>' +
      '</div>';
  }

  return '' +
    '<div class="onboarding-step-copy">' +
      '<p class="onboarding-eyebrow">Choose your starting point</p>' +
      '<h2 id="onboardingTitle">What would be most useful right now?</h2>' +
      '<p>We will take you there when setup is complete.</p>' +
    '</div>' +
    '<div class="onboarding-destinations">' +
      renderDestination('briefings', 'Briefings', 'Catch up on the latest market and world intelligence.', true) +
      renderDestination('members', 'Members', 'See who is in the network and discover relevant expertise.', false) +
      renderDestination('feed', 'Feed', 'Read updates and join the active circle conversations.', false) +
    '</div>';
};

var closeOnboarding = function() {
  if (onboardingTeardown) {
    onboardingTeardown();
    onboardingTeardown = null;
  }
  var backdrop = document.getElementById('onboardingBackdrop');
  if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
};

var rememberProfileDraft = function() {
  var roleEl = document.getElementById('onboardingRole');
  var bioEl = document.getElementById('onboardingBio');
  if (roleEl) onboardingDraft.role = roleEl.value.trim();
  if (bioEl) onboardingDraft.bio = bioEl.value.trim();
};

var finishOnboarding = function(button) {
  if (!state.user || !state.needsOnboarding) return;
  button.disabled = true;
  button.textContent = 'Saving...';

  updateDoc(doc(db, 'users', state.user.uid), {
    role: onboardingDraft.role,
    bio: onboardingDraft.bio,
    onboardingCompleted: true,
    onboardingCompletedAt: serverTimestamp(),
    onboardingStartPage: onboardingDraft.destination
  }).then(function() {
    state.needsOnboarding = false;
    closeOnboarding();
    showToast('Welcome to Enclave. Your profile is ready.', 'success');
    loadPage(onboardingDraft.destination);
  }).catch(function(err) {
    logError('Onboarding save failed', err);
    showToast('Could not finish setup. Please try again.', 'error');
    button.disabled = false;
    button.textContent = 'Finish setup';
  });
};

var renderStep = function() {
  var content = document.getElementById('onboardingContent');
  var progress = document.getElementById('onboardingProgress');
  var actions = document.getElementById('onboardingActions');
  if (!content || !progress || !actions) return;

  progress.innerHTML = renderProgress();
  content.innerHTML = stepContent();

  if (onboardingStep === 0) {
    actions.innerHTML = '' +
      '<button type="button" class="btn btn-ghost" id="onboardingSkip">Do this later</button>' +
      '<button type="button" class="btn btn-primary" id="onboardingNext">Set up profile</button>';
  } else if (onboardingStep === 1) {
    actions.innerHTML = '' +
      '<button type="button" class="btn btn-ghost" id="onboardingBack">Back</button>' +
      '<button type="button" class="btn btn-primary" id="onboardingNext">Continue</button>';
  } else {
    actions.innerHTML = '' +
      '<button type="button" class="btn btn-ghost" id="onboardingBack">Back</button>' +
      '<button type="button" class="btn btn-primary" id="onboardingFinish">Finish setup</button>';
  }

  var skip = document.getElementById('onboardingSkip');
  if (skip) skip.addEventListener('click', closeOnboarding);

  var back = document.getElementById('onboardingBack');
  if (back) back.addEventListener('click', function() {
    if (onboardingStep === 1) rememberProfileDraft();
    onboardingStep -= 1;
    renderStep();
  });

  var next = document.getElementById('onboardingNext');
  if (next) next.addEventListener('click', function() {
    if (onboardingStep === 1) {
      rememberProfileDraft();
      if (!onboardingDraft.role) {
        showToast('Add your role or specialty to continue.', 'error');
        var roleEl = document.getElementById('onboardingRole');
        if (roleEl) roleEl.focus();
        return;
      }
    }
    onboardingStep += 1;
    renderStep();
  });

  document.querySelectorAll('[data-onboarding-destination]').forEach(function(choice) {
    choice.addEventListener('click', function() {
      onboardingDraft.destination = choice.dataset.onboardingDestination;
      document.querySelectorAll('[data-onboarding-destination]').forEach(function(item) {
        var active = item.dataset.onboardingDestination === onboardingDraft.destination;
        item.classList.toggle('selected', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
  });

  var finish = document.getElementById('onboardingFinish');
  if (finish) finish.addEventListener('click', function() {
    finishOnboarding(finish);
  });

  var focusTarget = onboardingStep === 1
    ? document.getElementById('onboardingRole')
    : (onboardingStep === 2
      ? document.querySelector('.onboarding-destination.selected')
      : document.getElementById('onboardingNext'));
  if (focusTarget) focusTarget.focus();
};

export var openOnboarding = function() {
  if (!state.user || !state.needsOnboarding || document.getElementById('onboardingBackdrop')) return;

  onboardingStep = 0;
  onboardingDraft = { role: '', bio: '', destination: 'briefings' };

  var backdrop = document.createElement('div');
  backdrop.id = 'onboardingBackdrop';
  backdrop.className = 'onboarding-backdrop';
  backdrop.innerHTML = '' +
    '<section class="onboarding-card">' +
      '<div class="onboarding-header">' +
        '<div class="onboarding-wordmark">ENCLAVE</div>' +
        '<ol class="onboarding-progress" id="onboardingProgress" aria-label="Onboarding progress"></ol>' +
      '</div>' +
      '<div class="onboarding-content" id="onboardingContent"></div>' +
      '<div class="onboarding-actions" id="onboardingActions"></div>' +
    '</section>';

  document.body.appendChild(backdrop);
  renderStep();

  var card = backdrop.querySelector('.onboarding-card');
  onboardingTeardown = wireModalA11y({
    card: card,
    title: document.getElementById('onboardingTitle'),
    initialFocus: document.getElementById('onboardingNext'),
    onClose: closeOnboarding
  });
};
