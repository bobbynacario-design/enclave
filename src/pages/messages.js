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
  startAfter,
  onSnapshot,
  getDocs,
  serverTimestamp,
  Timestamp,
  runTransaction,
  deleteField
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, messagesState } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr, linkifyText, highlightMentions } from '../util/escape.js';
import { relativeTime, getFirestoreTimeMs } from '../util/time.js';
import { getInitials } from '../util/circles.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { openImageLightbox, uploadChatImage } from '../ui/photoAttach.js';

// Notifications
import { writeNotification } from './notifications.js';

// ─── Messages: time formatting ───────────────────────────────────────────────
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

var startOfDay = function(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

var formatClockTime = function(date) {
  var hours = date.getHours();
  var mins = date.getMinutes();
  var ampm = hours >= 12 ? 'PM' : 'AM';
  var h = hours % 12 || 12;
  return h + ':' + (mins < 10 ? '0' : '') + mins + ' ' + ampm;
};

// Day-chip label between message groups: Today / Yesterday / Jun 9
var formatDayLabel = function(date) {
  var now = new Date();
  var today = startOfDay(now);
  var yesterday = new Date(today.getTime() - 86400000);
  var msgDay = startOfDay(date);
  if (msgDay.getTime() === today.getTime()) return 'Today';
  if (msgDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return MONTHS[date.getMonth()] + ' ' + date.getDate() +
    (date.getFullYear() !== now.getFullYear() ? ', ' + date.getFullYear() : '');
};

// Compact sidebar time: 3:42 PM today, Yesterday, else Jun 9
var formatListTime = function(ms) {
  if (!ms) return '';
  var date = new Date(ms);
  var now = new Date();
  var today = startOfDay(now);
  var yesterday = new Date(today.getTime() - 86400000);
  var msgDay = startOfDay(date);
  if (msgDay.getTime() === today.getTime()) return formatClockTime(date);
  if (msgDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return MONTHS[date.getMonth()] + ' ' + date.getDate();
};

var PRESENCE_ONLINE_MS = 5 * 60 * 1000;
var TYPING_VISIBLE_MS = 8000;

// Clock-skew-immune typing freshness: track when THIS client first saw
// each new typing timestamp and time the indicator from that local
// receipt moment. Comparing the server timestamp directly against the
// local clock breaks whenever the device clock is a few seconds off.
// Keyed by conversation id → { ms: lastSeenTypingValue, seenAt: localMs }.
var typingSeen = {};

var isMemberOnline = function(member) {
  var ms = member ? getFirestoreTimeMs(member.lastSeen) : 0;
  return ms > 0 && Date.now() - ms < PRESENCE_ONLINE_MS;
};

var getConversationId = function(uidA, uidB) {
  return [uidA, uidB].sort().join('__');
};

var getConversationPeerId = function(conversation) {
  var members = Array.isArray(conversation.members) ? conversation.members : [];
  return members.filter(function(uid) {
    return uid !== (state.user && state.user.uid);
  })[0] || null;
};

var getConversationSortValue = function(conversation) {
  var ts = conversation.updatedAt || conversation.createdAt;
  if (ts && typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
  return 0;
};

var findMessageMember = function(uid) {
  return messagesState.members.find(function(member) {
    return member.uid === uid;
  }) || null;
};

var findConversationForPeer = function(peerId) {
  return messagesState.conversations.find(function(conversation) {
    return getConversationPeerId(conversation) === peerId;
  }) || null;
};

var getConversationUnreadCount = function(conversation) {
  if (!conversation || !state.user) return 0;

  var unreadCount = conversation.unreadCount || {};
  var value = unreadCount[state.user.uid];
  return typeof value === 'number' && value > 0 ? value : 0;
};

var syncMessagesUnreadState = function() {
  var total = 0;

  messagesState.conversations.forEach(function(conversation) {
    total += getConversationUnreadCount(conversation);
  });

  messagesState.totalUnread = total;

  document.querySelectorAll('[data-page="messages"]').forEach(function(link) {
    var badge = link.querySelector('.messages-nav-badge');
    if (total > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'messages-nav-badge';
        link.appendChild(badge);
      }
      badge.textContent = total > 99 ? '99+' : String(total);
    } else if (badge) {
      badge.remove();
    }
  });

  var sidebarHeader = document.getElementById('messagesSidebarHeader');
  if (sidebarHeader) {
    sidebarHeader.innerHTML = 'People' + (
      total > 0
        ? '<span class="messages-sidebar-count">' + escapeHTML(total > 99 ? '99+' : String(total)) + ' unread</span>'
        : ''
    );
  }
};

var markConversationRead = function(conversationId) {
  if (!state.user || !conversationId) return Promise.resolve();

  var conversation = messagesState.conversations.find(function(item) {
    return item.id === conversationId;
  });
  if (!conversation) return Promise.resolve();

  var unread = getConversationUnreadCount(conversation);
  if (unread <= 0) return Promise.resolve();

  if (!conversation.unreadCount) conversation.unreadCount = {};
  conversation.unreadCount[state.user.uid] = 0;
  if (!conversation.readBy) conversation.readBy = {};
  conversation.readBy[state.user.uid] = Timestamp.now();
  syncMessagesUnreadState();
  renderMessagesPeopleList();

  var payload = {};
  payload['unreadCount.' + state.user.uid] = 0;
  payload['readBy.' + state.user.uid] = serverTimestamp();

  return updateDoc(doc(db, 'conversations', conversationId), payload).catch(function(err) {
    logError('Failed to mark conversation read', err);
  });
};

var renderMessagesPeopleList = function() {
  var list = document.getElementById('messagesPeopleList');
  if (!list) return;

  if (messagesState.members.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No members found</div><p class="empty-state-text">Members will appear here once they\'ve signed in.</p></div>';
    return;
  }

  var convByPeer = {};
  messagesState.conversations.forEach(function(conversation) {
    var peerId = getConversationPeerId(conversation);
    if (peerId) convByPeer[peerId] = conversation;
  });

  var members = messagesState.members.slice().sort(function(a, b) {
    var convA = convByPeer[a.uid];
    var convB = convByPeer[b.uid];

    if (convA && convB) {
      return getConversationSortValue(convB) - getConversationSortValue(convA);
    }
    if (convA) return -1;
    if (convB) return 1;
    return (a.name || a.email || '').localeCompare(b.name || b.email || '');
  });

  syncMessagesUnreadState();

  list.innerHTML = members.map(function(member) {
    var active = member.uid === messagesState.activePeerId ? ' active' : '';
    var initials = escapeHTML(getInitials(member.name || member.email || '?'));
    var name = escapeHTML(member.name || member.email || 'Member');
    var conversation = convByPeer[member.uid] || null;
    var unread = getConversationUnreadCount(conversation);
    var online = isMemberOnline(member);
    var timeLabel = conversation ? formatListTime(getConversationSortValue(conversation)) : '';

    var preview;
    if (conversation && conversation.lastMessage) {
      var youPrefix = state.user && conversation.lastSenderId === state.user.uid ? 'You: ' : '';
      preview = escapeHTML(youPrefix + conversation.lastMessage);
    } else {
      preview = escapeHTML(member.role || member.email || 'No messages yet.');
    }

    return '' +
      '<button class="messages-person' + active + (unread > 0 ? ' unread' : '') + '" type="button" data-open-message="' + escapeAttr(member.uid) + '">' +
        '<div class="messages-person-avatar' + (online ? ' online' : '') + '">' + initials + '</div>' +
        '<div class="messages-person-meta">' +
          '<div class="messages-person-name-row">' +
            '<div class="messages-person-name">' + name + '</div>' +
            (timeLabel ? '<span class="messages-person-time' + (unread > 0 ? ' unread' : '') + '">' + escapeHTML(timeLabel) + '</span>' : '') +
          '</div>' +
          '<div class="messages-person-preview-row">' +
            '<div class="messages-person-preview">' + preview + '</div>' +
            (unread > 0 ? '<span class="messages-unread-badge">' + escapeHTML(unread > 99 ? '99+' : String(unread)) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</button>';
  }).join('');

  list.querySelectorAll('[data-open-message]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openMessageThread(btn.dataset.openMessage);
    });
  });
};

// Header subtitle: typing… beats presence; presence is online / last seen.
// Re-checks itself shortly after showing "typing…" so it expires cleanly.
var presenceRefreshTimer = null;

var renderThreadPresence = function() {
  var subtitleEl = document.getElementById('messagesThreadSubtitle');
  if (!subtitleEl) return;

  if (presenceRefreshTimer) {
    clearTimeout(presenceRefreshTimer);
    presenceRefreshTimer = null;
  }

  var peer = findMessageMember(messagesState.activePeerId);
  if (!peer) {
    subtitleEl.textContent = 'Choose someone to start chatting.';
    subtitleEl.classList.remove('typing');
    return;
  }

  var conversation = messagesState.conversations.find(function(item) {
    return item.id === messagesState.activeConversationId;
  }) || null;
  var typingMs = conversation && conversation.typing
    ? getFirestoreTimeMs(conversation.typing[peer.uid])
    : 0;

  var entry = conversation ? typingSeen[conversation.id] : null;
  if (conversation && typingMs > 0 && (!entry || typingMs > entry.ms)) {
    entry = { ms: typingMs, seenAt: Date.now() };
    typingSeen[conversation.id] = entry;
  }
  var showTyping = typingMs > 0 && entry &&
    Date.now() - entry.seenAt < TYPING_VISIBLE_MS;

  if (showTyping) {
    subtitleEl.textContent = 'typing…';
    subtitleEl.classList.add('typing');
    presenceRefreshTimer = setTimeout(renderThreadPresence, 2000);
    return;
  }

  subtitleEl.classList.remove('typing');
  if (isMemberOnline(peer)) {
    subtitleEl.textContent = 'online';
  } else {
    var lastSeenMs = getFirestoreTimeMs(peer.lastSeen);
    subtitleEl.textContent = lastSeenMs > 0
      ? 'last seen ' + relativeTime(new Date(lastSeenMs))
      : (peer.role || peer.email || 'Direct conversation');
  }
};

// Live presence for the open thread's peer (lastSeen heartbeats are
// written every 60s by the shell). Re-subscribes only when the open
// peer actually changes.
var presencePeerId = null;

var ensurePeerPresence = function() {
  if (messagesState.activePeerId === presencePeerId && messagesState.unsubscribePeer) return;
  presencePeerId = messagesState.activePeerId;
  subscribePeerPresence(presencePeerId);
};

var subscribePeerPresence = function(peerId) {
  if (messagesState.unsubscribePeer) {
    messagesState.unsubscribePeer();
    messagesState.unsubscribePeer = null;
  }
  if (!peerId) return;

  messagesState.unsubscribePeer = onSnapshot(doc(db, 'users', peerId), function(snap) {
    if (!snap.exists()) return;
    var member = findMessageMember(peerId);
    if (member) member.lastSeen = (snap.data() || {}).lastSeen || member.lastSeen;
    renderThreadPresence();
  }, function(err) {
    logError('Peer presence subscribe error', err);
  });
};

var renderMessageBubble = function(message, mine, peerReadAtMs, imageIndexRef) {
  var createdMs = getFirestoreTimeMs(message.createdAt);
  var timeLabel = createdMs > 0 ? formatClockTime(new Date(createdMs)) : '';
  var ticksHtml = '';
  if (mine) {
    var seen = peerReadAtMs > 0 && createdMs > 0 && createdMs <= peerReadAtMs;
    ticksHtml = '<span class="message-ticks' + (seen ? ' seen' : '') + '">' + (seen ? '✓✓' : '✓') + '</span>';
  }

  var imageHtml = '';
  if (message.imageUrl) {
    imageHtml = '<button type="button" class="message-image" data-msg-image="' + imageIndexRef.list.length + '" aria-label="View photo">' +
      '<img src="' + escapeAttr(message.imageUrl) + '" alt="Photo" loading="lazy" />' +
    '</button>';
    imageIndexRef.list.push({ url: message.imageUrl });
  }

  var bodyHtml = message.body
    ? '<span class="message-bubble-body">' + highlightMentions(linkifyText(escapeHTML(message.body))) + '</span>'
    : '';

  return '<div class="message-bubble' + (message.imageUrl ? ' has-image' : '') + '">' +
    imageHtml +
    '<span class="message-bubble-line">' +
      bodyHtml +
      '<span class="message-bubble-meta-inline">' + escapeHTML(timeLabel) + ticksHtml + '</span>' +
    '</span>' +
  '</div>';
};

var renderMessagesThread = function() {
  var titleEl = document.getElementById('messagesThreadTitle');
  var subtitleEl = document.getElementById('messagesThreadSubtitle');
  var listEl = document.getElementById('messagesThreadList');
  var inputEl = document.getElementById('messagesComposeInput');
  var sendBtn = document.getElementById('messagesSendBtn');
  var photoBtn = document.getElementById('messagesPhotoBtn');

  if (!titleEl || !subtitleEl || !listEl || !inputEl || !sendBtn) return;

  var peer = findMessageMember(messagesState.activePeerId);

  var headerAvatar = document.getElementById('messagesThreadHeaderAvatar');
  if (headerAvatar) {
    if (peer) {
      headerAvatar.textContent = getInitials(peer.name || peer.email || '?');
      headerAvatar.style.display = 'flex';
      headerAvatar.classList.toggle('online', isMemberOnline(peer));
    } else {
      headerAvatar.textContent = '';
      headerAvatar.style.display = 'none';
    }
  }

  if (!peer) {
    titleEl.textContent = 'Select a member';
    renderThreadPresence();
    listEl.innerHTML = '<div class="empty-state"><div class="empty-state-title">No conversation selected</div><p class="empty-state-text">Choose a member to start or continue a conversation.</p></div>';
    inputEl.value = '';
    inputEl.disabled = true;
    sendBtn.disabled = true;
    if (photoBtn) photoBtn.disabled = true;
    return;
  }

  titleEl.textContent = peer.name || peer.email || 'Member';
  renderThreadPresence();
  ensurePeerPresence();
  inputEl.disabled = false;
  sendBtn.disabled = false;
  if (photoBtn) photoBtn.disabled = false;

  var activeConversation = messagesState.conversations.find(function(conversation) {
    return conversation.id === messagesState.activeConversationId;
  }) || null;
  var peerReadAt = activeConversation && activeConversation.readBy
    ? activeConversation.readBy[peer.uid]
    : null;
  var peerReadAtMs = getFirestoreTimeMs(peerReadAt);

  var allMessages = messagesState.olderMessages.concat(messagesState.thread);

  if (allMessages.length === 0) {
    listEl.innerHTML = '<div class="empty-state"><div class="empty-state-title">No messages yet</div><p class="empty-state-text">Send the first message to start the conversation.</p></div>';
    return;
  }

  var loadMoreHtml = messagesState.hasMoreMessages
    ? '<div style="text-align:center;padding:8px 0;"><button class="btn btn-ghost" id="loadOlderMessagesBtn">' +
      (messagesState.loadingOlder ? 'Loading...' : 'Load older messages') + '</button></div>'
    : '';

  // Only yank the scroll to the bottom when the reader is already near
  // it (or on first render); preserves position while reading history.
  var nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 150 ||
    listEl.scrollTop === 0;
  var previousScrollTop = listEl.scrollTop;

  var html = loadMoreHtml;
  var previousMessage = null;
  var previousDayKey = '';
  var imageIndexRef = { list: [] };

  allMessages.forEach(function(message) {
    var mine = message.authorId === (state.user && state.user.uid);
    var createdMs = getFirestoreTimeMs(message.createdAt);

    // Day chip whenever the calendar day changes
    var dayKey = '';
    if (createdMs > 0) {
      var msgDate = new Date(createdMs);
      dayKey = msgDate.getFullYear() + '-' + msgDate.getMonth() + '-' + msgDate.getDate();
      if (dayKey !== previousDayKey) {
        html += '<div class="message-day-separator"><span>' + escapeHTML(formatDayLabel(msgDate)) + '</span></div>';
      }
    }

    var isGrouped = !!(previousMessage &&
      dayKey === previousDayKey &&
      previousMessage.authorId === message.authorId &&
      (createdMs - getFirestoreTimeMs(previousMessage.createdAt)) <= 300000);

    html += '<div class="message-bubble-row' + (mine ? ' mine' : '') + (isGrouped ? ' grouped' : '') + '">' +
      renderMessageBubble(message, mine, peerReadAtMs, imageIndexRef) +
    '</div>';

    previousMessage = message;
    previousDayKey = dayKey;
  });

  listEl.innerHTML = html;

  // Wire load older button
  var olderBtn = document.getElementById('loadOlderMessagesBtn');
  if (olderBtn) {
    olderBtn.addEventListener('click', loadOlderMessages);
  }

  // Wire image lightbox
  var threadImages = imageIndexRef.list;
  listEl.querySelectorAll('[data-msg-image]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openImageLightbox(threadImages, parseInt(btn.getAttribute('data-msg-image'), 10) || 0);
    });
  });

  // Only auto-scroll to bottom if not loading older messages and the
  // reader was already at/near the bottom
  if (!messagesState.loadingOlder && nearBottom) {
    listEl.scrollTop = listEl.scrollHeight;
  } else if (!messagesState.loadingOlder) {
    listEl.scrollTop = previousScrollTop;
  }
};

var subscribeMessageThread = function(conversationId) {
  if (messagesState.unsubscribeThread) {
    messagesState.unsubscribeThread();
    messagesState.unsubscribeThread = null;
  }

  messagesState.activeConversationId = conversationId;
  messagesState.thread = [];
  messagesState.olderMessages = [];
  messagesState.hasMoreMessages = false;
  messagesState.loadingOlder = false;
  messagesState.oldestDoc = null;

  var MESSAGE_PAGE = 100;

  var q = query(
    collection(db, 'conversations', conversationId, 'messages'),
    orderBy('createdAt', 'desc'),
    limit(MESSAGE_PAGE)
  );

  messagesState.unsubscribeThread = onSnapshot(q, function(snap) {
    var thread = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      thread.push(data);
    });
    messagesState.hasMoreMessages = thread.length >= MESSAGE_PAGE;
    messagesState.oldestDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
    thread.reverse();
    messagesState.thread = thread;
    renderMessagesThread();
    markConversationRead(conversationId);
  }, function(err) {
    logError('Failed to load thread', err);
    var listEl = document.getElementById('messagesThreadList');
    if (listEl) {
      listEl.innerHTML = '<div class="messages-empty-state text-muted">Failed to load messages.</div>';
    }
  });
};

var loadOlderMessages = function() {
  if (messagesState.loadingOlder || !messagesState.hasMoreMessages || !messagesState.oldestDoc) return;
  messagesState.loadingOlder = true;

  var convId = messagesState.activeConversationId;
  var q = query(
    collection(db, 'conversations', convId, 'messages'),
    orderBy('createdAt', 'desc'),
    startAfter(messagesState.oldestDoc),
    limit(100)
  );

  getDocs(q).then(function(snap) {
    var older = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      older.push(data);
    });

    messagesState.hasMoreMessages = older.length >= 100;
    if (snap.docs.length > 0) {
      messagesState.oldestDoc = snap.docs[snap.docs.length - 1];
    }

    older.reverse();
    messagesState.olderMessages = older.concat(messagesState.olderMessages);
    renderMessagesThread();
  }).catch(function(err) {
    logError('Load older messages error', err);
    showToast('Failed to load older messages.', 'error');
  }).finally(function() {
    messagesState.loadingOlder = false;
  });
};

var openMessageThread = function(peerId) {
  messagesState.activePeerId = peerId;
  var conversation = findConversationForPeer(peerId);

  renderMessagesPeopleList();

  if (!conversation) {
    if (messagesState.unsubscribeThread) {
      messagesState.unsubscribeThread();
      messagesState.unsubscribeThread = null;
    }
    messagesState.activeConversationId = null;
    messagesState.thread = [];
    renderMessagesThread();
    return;
  }

  subscribeMessageThread(conversation.id);
  markConversationRead(conversation.id);
  renderMessagesThread();
};

var loadMessageMembers = function() {
  getDocs(collection(db, 'users')).then(function(snap) {
    var members = [];
    snap.forEach(function(d) {
      if (!state.user || d.id === state.user.uid) return;
      var data = d.data();
      data.uid = d.id;
      members.push(data);
    });

    members.sort(function(a, b) {
      return (a.name || a.email || '').localeCompare(b.name || b.email || '');
    });

    messagesState.members = members;

    if (messagesState.activePeerId && !findMessageMember(messagesState.activePeerId)) {
      messagesState.activePeerId = null;
      messagesState.activeConversationId = null;
      messagesState.thread = [];
    }

    if (!messagesState.activePeerId && members.length > 0) {
      var firstConversation = messagesState.conversations[0];
      messagesState.activePeerId = firstConversation
        ? getConversationPeerId(firstConversation)
        : members[0].uid;
    }

    renderMessagesPeopleList();
    renderMessagesThread();
  }).catch(function(err) {
    logError('Failed to load message members', err);
    var list = document.getElementById('messagesPeopleList');
    if (list) {
      list.innerHTML = '<div class="messages-empty-state text-muted">Failed to load members.</div>';
    }
  });
};

export const subscribeConversations = function() {
  if (!state.user) return;

  if (messagesState.unsubscribeConversations) {
    messagesState.unsubscribeConversations();
    messagesState.unsubscribeConversations = null;
  }

  var q = query(
    collection(db, 'conversations'),
    where('members', 'array-contains', state.user.uid)
  );

  messagesState.unsubscribeConversations = onSnapshot(q, function(snap) {
    var conversations = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      conversations.push(data);
    });

    conversations.sort(function(a, b) {
      return getConversationSortValue(b) - getConversationSortValue(a);
    });

    messagesState.conversations = conversations;
    syncMessagesUnreadState();

    if (state.currentPage === 'messages' && messagesState.activePeerId) {
      var activeConversation = findConversationForPeer(messagesState.activePeerId);
      if (activeConversation) {
        if (messagesState.activeConversationId !== activeConversation.id) {
          subscribeMessageThread(activeConversation.id);
        }
        markConversationRead(activeConversation.id);
      } else {
        messagesState.activeConversationId = null;
        messagesState.thread = [];
      }
    } else if (state.currentPage === 'messages' && conversations.length > 0) {
      messagesState.activePeerId = getConversationPeerId(conversations[0]);
      subscribeMessageThread(conversations[0].id);
    }

    renderMessagesPeopleList();
    if (state.currentPage === 'messages') {
      renderMessagesThread();
    }
  }, function(err) {
    logError('Failed to load conversations', err);
    var list = document.getElementById('messagesPeopleList');
    if (list) {
      list.innerHTML = '<div class="messages-empty-state text-muted">Failed to load conversations.</div>';
    }
  });
};

// ─── Typing indicator pings ──────────────────────────────────────────────────
// Throttled write of typing.{uid} on the conversation doc; the peer's
// conversation listener picks it up. Displayed for TYPING_VISIBLE_MS.
var lastTypingWriteMs = 0;

var sendTypingPing = function() {
  if (!state.user || !messagesState.activeConversationId) return;
  var nowMs = Date.now();
  if (nowMs - lastTypingWriteMs < 2500) return;
  lastTypingWriteMs = nowMs;

  var payload = {};
  payload['typing.' + state.user.uid] = serverTimestamp();
  updateDoc(doc(db, 'conversations', messagesState.activeConversationId), payload).catch(function(err) {
    // Best-effort (the conversation may not exist yet), but surface the
    // error in the console so rule rejections are diagnosable.
    logError('Typing ping failed', err);
  });
};

var clearTypingPing = function(conversationId) {
  if (!state.user || !conversationId) return;
  lastTypingWriteMs = 0;
  var payload = {};
  payload['typing.' + state.user.uid] = deleteField();
  updateDoc(doc(db, 'conversations', conversationId), payload).catch(function() {});
};

// Shared send path for text and photo messages.
// content: { body } and/or { imageUrl, imagePath, imageW, imageH }
var sendMessage = function(content) {
  if (!state.user || !messagesState.activePeerId) return Promise.resolve();

  var peer = findMessageMember(messagesState.activePeerId);
  if (!peer) return Promise.resolve();

  var body = content.body || '';
  var conversationId = getConversationId(state.user.uid, peer.uid);
  var conversationRef = doc(db, 'conversations', conversationId);
  var preview = content.imageUrl
    ? '📷 Photo'
    : (body.length > 120 ? body.slice(0, 117) + '...' : body);
  var members = [state.user.uid, peer.uid].sort();

  return runTransaction(db, function(tx) {
    return tx.get(conversationRef).then(function(snap) {
      var unreadCount = {};
      var readBy = {};

      if (snap.exists()) {
        var data = snap.data() || {};
        unreadCount = Object.assign({}, data.unreadCount || {});
        readBy = Object.assign({}, data.readBy || {});
      }

      unreadCount[state.user.uid] = 0;
      unreadCount[peer.uid] = (typeof unreadCount[peer.uid] === 'number' ? unreadCount[peer.uid] : 0) + 1;
      readBy[state.user.uid] = Timestamp.now();

      tx.set(conversationRef, {
        members: members,
        updatedAt: serverTimestamp(),
        lastMessage: preview,
        lastSenderId: state.user.uid,
        unreadCount: unreadCount,
        readBy: readBy
      }, { merge: true });
    });
  }).then(function() {
    var messageDoc = {
      authorId: state.user.uid,
      authorName: state.user.displayName || state.user.email || 'Member',
      body: body,
      createdAt: serverTimestamp()
    };
    if (content.imageUrl) {
      messageDoc.imageUrl = content.imageUrl;
      messageDoc.imagePath = content.imagePath || '';
      messageDoc.imageW = content.imageW || 0;
      messageDoc.imageH = content.imageH || 0;
    }
    return addDoc(collection(db, 'conversations', conversationId, 'messages'), messageDoc);
  }).then(function() {
    messagesState.activePeerId = peer.uid;
    if (messagesState.activeConversationId !== conversationId) {
      subscribeMessageThread(conversationId);
    }
    markConversationRead(conversationId);
    clearTypingPing(conversationId);
    var actor = state.user.displayName || state.user.email || 'Member';
    var notifText = content.imageUrl
      ? actor + ' sent you a photo'
      : actor + ' sent you a message';
    try {
      writeNotification(peer.uid, 'message', notifText, {
        page: 'messages',
        params: { peer: state.user.uid }
      });
    } catch (err) {
      logError('Notification write failed', err);
    }
  });
};

var handleSendMessage = function() {
  var input = document.getElementById('messagesComposeInput');
  var sendBtn = document.getElementById('messagesSendBtn');
  if (!input || !sendBtn) return;

  var body = input.value.trim();
  if (!body) return;

  input.disabled = true;
  sendBtn.disabled = true;

  sendMessage({ body: body }).then(function() {
    input.value = '';
    input.style.height = 'auto';
  }).catch(function(err) {
    logError('Failed to send message', err);
    showToast('Failed to send message. Check console for details.', 'error');
  }).finally(function() {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  });
};

var handleSendPhoto = function(file) {
  var photoBtn = document.getElementById('messagesPhotoBtn');
  var sendBtn = document.getElementById('messagesSendBtn');
  if (!file) return;
  if (!file.type || file.type.indexOf('image/') !== 0) {
    showToast('Only image files can be sent.', 'error');
    return;
  }

  if (photoBtn) photoBtn.disabled = true;
  if (sendBtn) sendBtn.disabled = true;
  showToast('Sending photo...', 'info');

  uploadChatImage(file, 'chat-images').then(function(img) {
    return sendMessage({
      imageUrl: img.url,
      imagePath: img.path,
      imageW: img.w,
      imageH: img.h
    });
  }).catch(function(err) {
    logError('Failed to send photo', err);
    showToast(err && err.message === 'decode-failed'
      ? 'That image format is not supported.'
      : 'Failed to send photo. Try again.', 'error');
  }).finally(function() {
    if (photoBtn) photoBtn.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
  });
};

export const initMessagesPage = function() {
  presencePeerId = null;
  lastTypingWriteMs = 0;

  var form = document.getElementById('messagesComposer');
  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      handleSendMessage();
    });
  }

  var input = document.getElementById('messagesComposeInput');
  if (input) {
    var autosize = function() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    };
    input.addEventListener('input', function() {
      autosize();
      if (input.value) sendTypingPing();
    });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });
  }

  var photoBtn = document.getElementById('messagesPhotoBtn');
  var photoInput = document.getElementById('messagesPhotoInput');
  if (photoBtn && photoInput) {
    photoBtn.addEventListener('click', function() {
      photoInput.click();
    });
    photoInput.addEventListener('change', function() {
      var file = photoInput.files && photoInput.files[0];
      photoInput.value = '';
      if (file) handleSendPhoto(file);
    });
  }

  renderMessagesPeopleList();
  renderMessagesThread();
  loadMessageMembers();
};
