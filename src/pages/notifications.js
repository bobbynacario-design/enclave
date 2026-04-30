// Firebase
import {
  doc,
  collection,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, notificationsState } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr } from '../util/escape.js';
import { relativeTime } from '../util/time.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';

let notificationNavigator = function() {};

export const registerNotificationNavigator = function(fn) {
  notificationNavigator = fn;
};

export const writeNotification = function(recipientId, type, message, link) {
  if (!state.user || !recipientId) return Promise.resolve();
  if (recipientId === state.user.uid) return Promise.resolve();

  return addDoc(collection(db, 'notifications'), {
    recipientId: recipientId,
    type:        type,
    message:     message,
    link:        link || { page: 'feed', params: {} },
    read:        false,
    createdAt:   serverTimestamp(),
    actorId:     state.user.uid,
    actorName:   state.user.displayName || state.user.email || 'Member'
  }).catch(function(err) {
    logError('Failed to write notification', err);
  });
};

const syncNotificationBadge = function() {
  const count = notificationsState.unreadCount;

  document.querySelectorAll('[data-page="notifications"]').forEach(function(link) {
    let badge = link.querySelector('.notif-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'notif-badge';
        link.appendChild(badge);
      }
      badge.textContent = count > 99 ? '99+' : String(count);
    } else if (badge) {
      badge.remove();
    }
  });
};

export const subscribeNotifications = function() {
  if (notificationsState.unsubscribe) {
    notificationsState.unsubscribe();
    notificationsState.unsubscribe = null;
  }
  if (!state.user) return;

  const q = query(
    collection(db, 'notifications'),
    where('recipientId', '==', state.user.uid),
    orderBy('createdAt', 'desc'),
    limit(50)
  );

  notificationsState.unsubscribe = onSnapshot(q, function(snap) {
    notificationsState.notifications = [];
    snap.forEach(function(d) {
      const data = d.data();
      data.id = d.id;
      notificationsState.notifications.push(data);
    });

    notificationsState.unreadCount = notificationsState.notifications.filter(function(n) {
      return !n.read;
    }).length;

    syncNotificationBadge();

    if (state.currentPage === 'notifications') {
      renderNotificationsList();
    }
  }, function(err) {
    logError('Notifications subscription error', err);
  });
};

const NOTIF_TYPE_ICONS = {
  'mention':         '💬',
  'task-assigned':   '📋',
  'task-status':     '🔄',
  'post-comment':    '💬',
  'project-comment': '💬',
  'event-rsvp':      '📅'
};

const renderNotificationsList = function() {
  const listEl = document.getElementById('notificationsList');
  if (!listEl) return;

  const items = notificationsState.notifications;
  if (items.length === 0) {
    listEl.innerHTML = '<p class="text-muted">No notifications yet.</p>';
    return;
  }

  listEl.innerHTML = items.map(function(n) {
    const icon = NOTIF_TYPE_ICONS[n.type] || '🔔';
    let time = '';
    if (n.createdAt && typeof n.createdAt.toDate === 'function') {
      time = relativeTime(n.createdAt.toDate());
    }
    const unreadClass = n.read ? '' : ' notif-unread';
    return '<div class="notif-item' + unreadClass + '" data-notif-id="' + escapeAttr(n.id) + '" data-notif-page="' + escapeAttr(n.link && n.link.page || '') + '" data-notif-params="' + escapeAttr(JSON.stringify(n.link && n.link.params || {})) + '">' +
      '<span class="notif-icon">' + icon + '</span>' +
      '<div class="notif-content">' +
        '<div class="notif-message">' + escapeHTML(n.message) + '</div>' +
        '<div class="notif-time">' + escapeHTML(time) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  listEl.querySelectorAll('.notif-item').forEach(function(item) {
    item.addEventListener('click', function() {
      const nid = item.getAttribute('data-notif-id');
      const page = item.getAttribute('data-notif-page');
      let params = {};
      try { params = JSON.parse(item.getAttribute('data-notif-params')); } catch(e) {}

      // Mark as read
      const n = notificationsState.notifications.find(function(x) { return x.id === nid; });
      if (n && !n.read) {
        updateDoc(doc(db, 'notifications', nid), { read: true }).catch(function(err) {
          logError('Mark read error', err);
        });
      }

      // Navigate
      notificationNavigator(page, params);
    });
  });
};

export const initNotificationsPage = function() {
  renderNotificationsList();

  const markAllBtn = document.getElementById('markAllReadBtn');
  if (markAllBtn) {
    markAllBtn.addEventListener('click', function() {
      const unread = notificationsState.notifications.filter(function(n) { return !n.read; });
      if (unread.length === 0) {
        showToast('All caught up!', 'info');
        return;
      }
      Promise.all(unread.map(function(n) {
        return updateDoc(doc(db, 'notifications', n.id), { read: true });
      })).then(function() {
        showToast('All marked as read.', 'info');
      }).catch(function(err) {
        logError('Mark all read error', err);
      });
    });
  }
};
