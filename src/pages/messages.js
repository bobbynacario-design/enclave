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
  runTransaction
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, messagesState } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr } from '../util/escape.js';
import { relativeTime, getFirestoreTimeMs } from '../util/time.js';
import { getInitials } from '../util/circles.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';

// ─── Messages ────────────────────────────────────────────────────────────────
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
    list.innerHTML = '<div class="messages-empty-state text-muted">No other members found yet.</div>';
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
    var meta = escapeHTML(member.role || member.email || '');
    var conversation = convByPeer[member.uid] || null;
    var unread = getConversationUnreadCount(conversation);
    var preview = conversation && conversation.lastMessage
      ? escapeHTML(conversation.lastMessage)
      : 'No messages yet.';

    return '' +
      '<button class="messages-person' + active + (unread > 0 ? ' unread' : '') + '" type="button" data-open-message="' + escapeAttr(member.uid) + '">' +
        '<div class="messages-person-avatar">' + initials + '</div>' +
        '<div class="messages-person-meta">' +
          '<div class="messages-person-name-row">' +
            '<div class="messages-person-name">' + name + '</div>' +
            (unread > 0 ? '<span class="messages-unread-badge">' + escapeHTML(unread > 99 ? '99+' : String(unread)) + '</span>' : '') +
          '</div>' +
          '<div class="messages-person-subtitle">' + meta + '</div>' +
          '<div class="messages-person-preview">' + preview + '</div>' +
        '</div>' +
      '</button>';
  }).join('');

  list.querySelectorAll('[data-open-message]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      openMessageThread(btn.dataset.openMessage);
    });
  });
};

var renderMessagesThread = function() {
  var titleEl = document.getElementById('messagesThreadTitle');
  var subtitleEl = document.getElementById('messagesThreadSubtitle');
  var listEl = document.getElementById('messagesThreadList');
  var inputEl = document.getElementById('messagesComposeInput');
  var sendBtn = document.getElementById('messagesSendBtn');

  if (!titleEl || !subtitleEl || !listEl || !inputEl || !sendBtn) return;

  var peer = findMessageMember(messagesState.activePeerId);
  if (!peer) {
    titleEl.textContent = 'Select a member';
    subtitleEl.textContent = 'Choose someone to start chatting.';
    listEl.innerHTML = '<div class="messages-empty-state text-muted">No conversation selected yet.</div>';
    inputEl.value = '';
    inputEl.disabled = true;
    sendBtn.disabled = true;
    return;
  }

  titleEl.textContent = peer.name || peer.email || 'Member';
  subtitleEl.textContent = peer.role || peer.email || 'Direct conversation';
  inputEl.disabled = false;
  sendBtn.disabled = false;

  var activeConversation = messagesState.conversations.find(function(conversation) {
    return conversation.id === messagesState.activeConversationId;
  }) || null;
  var peerReadAt = activeConversation && activeConversation.readBy
    ? activeConversation.readBy[peer.uid]
    : null;
  var peerReadAtMs = getFirestoreTimeMs(peerReadAt);
  var lastOwnMessageId = null;

  var allMsgs = messagesState.olderMessages.concat(messagesState.thread);
  for (var i = allMsgs.length - 1; i >= 0; i -= 1) {
    if (allMsgs[i].authorId === (state.user && state.user.uid)) {
      lastOwnMessageId = allMsgs[i].id;
      break;
    }
  }

  var allMessages = messagesState.olderMessages.concat(messagesState.thread);

  if (allMessages.length === 0) {
    listEl.innerHTML = '<div class="messages-empty-state text-muted">No messages yet. Send the first one.</div>';
    return;
  }

  var loadMoreHtml = messagesState.hasMoreMessages
    ? '<div style="text-align:center;padding:8px 0;"><button class="btn btn-ghost" id="loadOlderMessagesBtn">' +
      (messagesState.loadingOlder ? 'Loading...' : 'Load older messages') + '</button></div>'
    : '';

  listEl.innerHTML = loadMoreHtml + allMessages.map(function(message) {
    var mine = message.authorId === (state.user && state.user.uid);
    var author = escapeHTML(message.authorName || 'Member');
    var body = escapeHTML(message.body || '');
    var time = 'just now';
    var isLatestOwn = mine && message.id === lastOwnMessageId;
    var seen = isLatestOwn && peerReadAtMs > 0 && getFirestoreTimeMs(message.createdAt) <= peerReadAtMs;
    var statusHtml = isLatestOwn
      ? '<div class="message-bubble-status' + (seen ? ' seen' : '') + '">' + (seen ? 'Seen' : 'Sent') + '</div>'
      : '';

    if (message.createdAt && typeof message.createdAt.toDate === 'function') {
      time = relativeTime(message.createdAt.toDate());
    }

    return '' +
      '<div class="message-bubble-row' + (mine ? ' mine' : '') + '">' +
        '<div class="message-bubble">' +
          '<div class="message-bubble-meta">' + author + ' · ' + escapeHTML(time) + '</div>' +
          '<div class="message-bubble-body">' + body + '</div>' +
          statusHtml +
        '</div>' +
      '</div>';
  }).join('');

  // Wire load older button
  var olderBtn = document.getElementById('loadOlderMessagesBtn');
  if (olderBtn) {
    olderBtn.addEventListener('click', loadOlderMessages);
  }

  // Only auto-scroll to bottom if not loading older messages
  if (!messagesState.loadingOlder) {
    listEl.scrollTop = listEl.scrollHeight;
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

var handleSendMessage = function() {
  if (!state.user || !messagesState.activePeerId) return;

  var input = document.getElementById('messagesComposeInput');
  var sendBtn = document.getElementById('messagesSendBtn');
  if (!input || !sendBtn) return;

  var body = input.value.trim();
  if (!body) return;

  var peer = findMessageMember(messagesState.activePeerId);
  if (!peer) return;

  var conversationId = getConversationId(state.user.uid, peer.uid);
  var conversationRef = doc(db, 'conversations', conversationId);
  var preview = body.length > 120 ? body.slice(0, 117) + '...' : body;
  var members = [state.user.uid, peer.uid].sort();

  input.disabled = true;
  sendBtn.disabled = true;

  runTransaction(db, function(tx) {
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
    return addDoc(collection(db, 'conversations', conversationId, 'messages'), {
      authorId: state.user.uid,
      authorName: state.user.displayName || state.user.email || 'Member',
      body: body,
      createdAt: serverTimestamp()
    });
  }).then(function() {
    messagesState.activePeerId = peer.uid;
    if (messagesState.activeConversationId !== conversationId) {
      subscribeMessageThread(conversationId);
    }
    markConversationRead(conversationId);
    input.value = '';
  }).catch(function(err) {
    logError('Failed to send message', err);
    showToast('Failed to send message. Check console for details.', 'error');
  }).finally(function() {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  });
};

export const initMessagesPage = function() {
  var form = document.getElementById('messagesComposer');
  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      handleSendMessage();
    });
  }

  renderMessagesPeopleList();
  renderMessagesThread();
  loadMessageMembers();
};
