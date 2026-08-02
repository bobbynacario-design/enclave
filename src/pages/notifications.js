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
  'event-rsvp':      '📅',
  'briefing':        '📰',
  'task-due':        '⏰',
  'project-invite':  '📁'
};

let notifFilter = 'all';
let markAllBusy = false;

const NOTIF_FILTER_TYPES = {
  conversations: ['mention', 'post-comment', 'project-comment'],
  work: ['task-assigned', 'task-status', 'task-due', 'project-invite'],
  updates: ['event-rsvp', 'briefing']
};

const NOTIF_FILTER_LABELS = {
  conversations: 'conversation',
  work: 'work',
  updates: 'update'
};

const refreshUnreadState = function() {
  notificationsState.unreadCount = notificationsState.notifications.filter(function(n) {
    return !n.read;
  }).length;
  syncNotificationBadge();
};

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
  const notification = notificationsState.notifications.find(function(item) { return item.id === nid; });
  if (!notification || notification.read) return Promise.resolve();

  notification.read = true;
  refreshUnreadState();
  renderNotificationsList();

  return updateDoc(doc(db, 'notifications', nid), { read: true }).catch(function(err) {
    const current = notificationsState.notifications.find(function(item) { return item.id === nid; });
    if (current) current.read = false;
    refreshUnreadState();
    renderNotificationsList();
    logError('Mark read error', err);
    showToast('Could not mark that notification as read.', 'error');
  });
};

const getFilteredNotifications = function() {
  const all = notificationsState.notifications;
  if (notifFilter === 'unread') return all.filter(function(n) { return !n.read; });
  if (NOTIF_FILTER_TYPES[notifFilter]) {
    return all.filter(function(n) {
      return NOTIF_FILTER_TYPES[notifFilter].indexOf(n.type) !== -1;
    });
  }
  return all;
};

const updateNotificationHeader = function(items) {
  const summary = document.getElementById('notificationsSummary');
  const markAllBtn = document.getElementById('markAllReadBtn');
  if (summary) {
    const filteredLabel = notifFilter === 'all' || notifFilter === 'unread'
      ? 'notification'
      : NOTIF_FILTER_LABELS[notifFilter];
    summary.textContent = items.length + ' ' + filteredLabel + (items.length === 1 ? '' : 's') +
      ' / ' + notificationsState.unreadCount + ' unread';
  }
  if (markAllBtn) {
    markAllBtn.disabled = markAllBusy || notificationsState.unreadCount === 0;
    markAllBtn.textContent = markAllBusy
      ? 'Marking...'
      : (notificationsState.unreadCount > 0
        ? 'Mark all read (' + notificationsState.unreadCount + ')'
        : 'All caught up');
  }
};

const renderNotificationsList = function() {
  const listEl = document.getElementById('notificationsList');
  if (!listEl) return;

  const items = getFilteredNotifications();
  updateNotificationHeader(items);

  if (items.length === 0) {
    const title = notifFilter === 'unread' ? 'You are all caught up' : (notifFilter === 'all' ? 'No notifications yet' : 'Nothing in this category');
    const text = notifFilter === 'unread'
      ? 'New activity will appear here as it happens.'
      : (notifFilter === 'all' ? 'Replies, assignments, invitations, and updates will appear here.' : 'Try another filter to see the rest of your activity.');
    const action = notifFilter !== 'all'
      ? '<button type="button" class="btn btn-ghost" data-show-all-notifications>Show all notifications</button>'
      : '';
    listEl.innerHTML = '<div class="empty-state notifications-empty-state">' +
      '<div class="empty-state-title">' + escapeHTML(title) + '</div>' +
      '<p class="empty-state-text">' + escapeHTML(text) + '</p>' + action +
    '</div>';
    const showAllBtn = listEl.querySelector('[data-show-all-notifications]');
    if (showAllBtn) {
      showAllBtn.addEventListener('click', function() {
        notifFilter = 'all';
        syncNotificationFilterUI();
        renderNotificationsList();
      });
    }
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
        ? '<button type="button" class="notif-mark-read" data-mark-id="' + escapeAttr(n.id) + '" title="Mark as read" aria-label="Mark as read">&#10003;</button>'
        : '';
      html += '<article class="notif-item' + unreadClass + '">' +
        '<button type="button" class="notif-open" data-open-notif="' + escapeAttr(n.id) + '">' +
          '<span class="notif-icon" aria-hidden="true">' + icon + '</span>' +
          '<span class="notif-content">' +
            '<span class="notif-message">' + escapeHTML(n.message) + '</span>' +
            '<span class="notif-time">' + escapeHTML(time) + '</span>' +
          '</span>' +
        '</button>' +
        markReadBtn +
      '</article>';
    });
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('.notif-mark-read').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      markNotifRead(btn.getAttribute('data-mark-id'));
    });
  });

  listEl.querySelectorAll('[data-open-notif]').forEach(function(item) {
    item.addEventListener('click', function() {
      const nid = item.getAttribute('data-open-notif');
      const n = notificationsState.notifications.find(function(x) { return x.id === nid; });
      if (!n) return;
      if (!n.read) markNotifRead(nid);
      const link = n.link || {};
      notificationNavigator(link.page || '', link.params || {});
    });
  });
};

const syncNotificationFilterUI = function() {
  document.querySelectorAll('[data-notif-filter]').forEach(function(pill) {
    const active = pill.getAttribute('data-notif-filter') === notifFilter;
    pill.classList.toggle('active', active);
    pill.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
};

export const initNotificationsPage = function() {
  renderNotificationsList();

  const filterPills = document.querySelectorAll('[data-notif-filter]');
  filterPills.forEach(function(pill) {
    pill.addEventListener('click', function() {
      notifFilter = pill.getAttribute('data-notif-filter');
      syncNotificationFilterUI();
      renderNotificationsList();
    });
  });
  syncNotificationFilterUI();

  const markAllBtn = document.getElementById('markAllReadBtn');
  if (markAllBtn) {
    markAllBtn.addEventListener('click', function() {
      const unread = notificationsState.notifications.filter(function(n) { return !n.read; });
      if (unread.length === 0) {
        showToast('All caught up!', 'info');
        return;
      }
      markAllBusy = true;
      updateNotificationHeader(getFilteredNotifications());
      Promise.all(unread.map(function(n) {
        return updateDoc(doc(db, 'notifications', n.id), { read: true });
      })).then(function() {
        unread.forEach(function(n) { n.read = true; });
        refreshUnreadState();
        showToast('All marked as read.', 'info');
      }).catch(function(err) {
        logError('Mark all read error', err);
        showToast('Some notifications could not be updated.', 'error');
      }).finally(function() {
        markAllBusy = false;
        renderNotificationsList();
      });
    });
  }
};
