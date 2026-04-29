import { state, pickerState, driveAttachment } from '../state.js';
import { escapeHTML, escapeAttr } from '../util/escape.js';
import { logError } from '../util/log.js';
import { showToast } from './toast.js';

const PICKER_APP_ID = '834210326738';
const PICKER_API_KEY = 'AIzaSyBC8nqTgaqMp0R45dnKpA44u0S5C3nnbFE';
let pickerApiLoaded = false;

let driveTokenClient = null;
const handlers = {};

export const registerPickerHandler = function(context, fn) {
  handlers[context] = fn;
};

export const openDrivePicker = function() {
  if (!state.user) {
    showToast('Sign in first.', 'error');
    return;
  }

  if (!window.google || !window.google.accounts) {
    showToast('Google Identity Services still loading. Try again.', 'error');
    return;
  }

  // If we already have a token, go straight to picker
  if (state.googleAccessToken) {
    loadAndShowPicker();
    return;
  }

  // Use GIS token client to get Drive access token on demand
  if (!driveTokenClient) {
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: '834210326738-mo90co5s9c6fogmb4kse67dkshmigt2l.apps.googleusercontent.com',
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: function(tokenResponse) {
        if (tokenResponse && tokenResponse.access_token) {
          state.googleAccessToken = tokenResponse.access_token;
          loadAndShowPicker();
        } else {
          showToast('Could not get Drive access.', 'error');
        }
      }
    });
  }

  driveTokenClient.requestAccessToken({ prompt: '' });
};

const loadAndShowPicker = function() {
  if (!window.gapi) {
    showToast('Google API still loading. Try again in a moment.', 'error');
    return;
  }

  if (pickerApiLoaded) {
    createPicker();
    return;
  }

  window.gapi.load('picker', function() {
    pickerApiLoaded = true;
    createPicker();
  });
};

const createPicker = function() {
  try {
    const docsView = new google.picker.DocsView()
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);

    const picker = new google.picker.PickerBuilder()
      .addView(docsView)
      .setOAuthToken(state.googleAccessToken)
      .setAppId(PICKER_APP_ID)
      .setCallback(handlePickerResult)
      .setTitle('Attach a file from Google Drive')
      .build();

    picker.setVisible(true);
  } catch (err) {
    logError('Picker build error', err);
    showToast('Failed to open Drive picker: ' + err.message, 'error');
  }
};

const attachFeedFile = function(file) {
  driveAttachment.fileUrl  = file.url || '';
  driveAttachment.fileName = file.name || 'Attached file';
  driveAttachment.iconUrl  = file.iconUrl || '';
  renderDrivePreview();
};

const handlePickerResult = function(data) {
  if (data.action === google.picker.Action.PICKED && data.docs && data.docs.length > 0) {
    const file = data.docs[0];
    const handler = handlers[pickerState.context];

    if (handler && handler(file) !== false) {
      return;
    }

    attachFeedFile(file);
  }

  // Reset picker context on cancel
  if (data.action === google.picker.Action.CANCEL) {
    pickerState.context = 'feed';
    pickerState.projectId = null;
  }
};

const renderDrivePreview = function() {
  const el = document.getElementById('driveAttachmentPreview');
  if (!el) return;

  if (!driveAttachment.fileUrl) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  const nameEsc = escapeHTML(driveAttachment.fileName);
  el.hidden = false;
  el.innerHTML =
    '<div class="drive-preview-file">' +
      (driveAttachment.iconUrl
        ? '<img src="' + escapeAttr(driveAttachment.iconUrl) + '" class="drive-preview-icon" alt="" />'
        : '<span class="drive-preview-icon-fallback">&#128196;</span>') +
      '<span class="drive-preview-name">' + nameEsc + '</span>' +
      '<button type="button" class="drive-preview-remove" title="Remove attachment">&times;</button>' +
    '</div>' +
    '<div class="drive-preview-reminder">' +
      '&#9888;&#65039; Before posting, set sharing in Google Drive:<br>' +
      '<strong>Open file → Share → General access → "Anyone with the link" → Viewer/Commenter/Editor</strong><br>' +
      'Choose <em>Viewer</em> for read-only, <em>Commenter</em> for feedback, or <em>Editor</em> for full collaboration.' +
    '</div>';

  // Wire remove button
  const removeBtn = el.querySelector('.drive-preview-remove');
  if (removeBtn) {
    removeBtn.onclick = function() {
      clearDriveAttachment();
    };
  }
};

export const clearDriveAttachment = function() {
  driveAttachment.fileUrl  = '';
  driveAttachment.fileName = '';
  driveAttachment.iconUrl  = '';
  const el = document.getElementById('driveAttachmentPreview');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
};
