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

let notifFilter = 'all';

const getDateGroup = function(date) {
  if (!date) return 'Earlier';
  const now = new Date();
  const d = new Date(date);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 6);

  if (d >= startOfToday) return 'Today';
  if (d >= startOfYesterday) return 'Yesterday';
  if (d >= startOfWeek) return 'This week';
  return 'Earlier';
};

const markNotifRead = function(nid) {
  updateDoc(doc(db, 'notifications', nid), { read: true }).catch(function(err) {
    logError('Mark read error', err);
  });
};

const renderNotificationsList = function() {
  const listEl = document.getElementById('notificationsList');
  if (!listEl) return;

  const all = notificationsState.notifications;
  const items = notifFilter === 'unread' ? all.filter(function(n) { return !n.read; }) : all;

  if (items.length === 0) {
    listEl.innerHTML = '<p class="text-muted">' + (notifFilter === 'unread' ? 'No unread notifications.' : 'No notifications yet.') + '</p>';
    return;
  }

  const groups = {};
  const groupOrder = [];
  items.forEach(function(n) {
    const date = n.createdAt && typeof n.createdAt.toDate === 'function' ? n.createdAt.toDate() : null;
    const group = getDateGroup(date);
    if (!groups[group]) {
      groups[group] = [];
      groupOrder.push(group);
    }
    groups[group].push(n);
  });

  let html = '';
  groupOrder.forEach(function(group) {
    html += '<div class="notif-date-group">' + escapeHTML(group) + '</div>';
    groups[group].forEach(function(n) {
      const icon = NOTIF_TYPE_ICONS[n.type] || '🔔';
      let time = '';
      if (n.createdAt && typeof n.createdAt.toDate === 'function') {
        time = relativeTime(n.createdAt.toDate());
      }
      const unreadClass = n.read ? '' : ' notif-unread';
      const markReadBtn = !n.read
        ? '<button class="notif-mark-read" data-mark-id="' + escapeAttr(n.id) + '" title="Mark as read" aria-label="Mark as read">&#10003;</button>'
        : '';
      html += '<div class="notif-item' + unreadClass + '" data-notif-id="' + escapeAttr(n.id) + '" data-notif-page="' + escapeAttr(n.link && n.link.page || '') + '" data-notif-params="' + escapeAttr(JSON.stringify(n.link && n.link.params || {})) + '">' +
        '<span class="notif-icon">' + icon + '</span>' +
        '<div class="notif-content">' +
          '<div class="notif-message">' + escapeHTML(n.message) + '</div>' +
          '<div class="notif-time">' + escapeHTML(time) + '</div>' +
        '</div>' +
        markReadBtn +
      '</div>';
    });
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('.notif-mark-read').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      markNotifRead(btn.getAttribute('data-mark-id'));
    });
  });

  listEl.querySelectorAll('.notif-item').forEach(function(item) {
    item.addEventListener('click', function() {
      const nid = item.getAttribute('data-notif-id');
      const page = item.getAttribute('data-notif-page');
      let params = {};
      try { params = JSON.parse(item.getAttribute('data-notif-params')); } catch(e) {}

      const n = notificationsState.notifications.find(function(x) { return x.id === nid; });
      if (n && !n.read) {
        markNotifRead(nid);
      }

      notificationNavigator(page, params);
    });
  });
};

export const initNotificationsPage = function() {
  renderNotificationsList();

  const filterPills = document.querySelectorAll('[data-notif-filter]');
  filterPills.forEach(function(pill) {
    pill.addEventListener('click', function() {
      notifFilter = pill.getAttribute('data-notif-filter');
      filterPills.forEach(function(p) { p.classList.remove('active'); });
      pill.classList.add('active');
      renderNotificationsList();
    });
  });

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
