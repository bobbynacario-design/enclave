// Firebase
import {
  doc,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  getDoc,
  getDocs,
  serverTimestamp,
  runTransaction,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, feedState, driveAttachment } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr, linkifyText, extractFirstUrl, highlightMentions } from '../util/escape.js';
import { relativeTime } from '../util/time.js';
import { getVisibleCircles, getInitials, renderCircleOptions } from '../util/circles.js';
import { FEED_PAGE_SIZE } from '../util/constants.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { showConfirmModal, showNoticeModal } from '../ui/modals.js';
import { openDrivePicker, clearDriveAttachment } from '../ui/drivePicker.js';

// Cross-page
import { writeNotification } from './notifications.js';

// Shell bridge
import { syncSidebarSelection, syncURLState, getAppURL } from '../util/shell-bridge.js';

// ─── Feed: init ──────────────────────────────────────────────────────────────
export const initFeedPage = function() {
  var visibleCircles = getVisibleCircles(state);
  var composeCircle = document.getElementById('composeCircle');
  var filterPills = document.querySelector('.filter-pills');

  if (visibleCircles.indexOf(feedState.filter) === -1) {
    feedState.filter = 'all';
  }

  var composeAv = document.querySelector('[data-slot="compose-avatar"]');
  if (composeAv && state.user) {
    if (state.user.photoURL) {
      composeAv.style.backgroundImage = 'url(' + escapeAttr(state.user.photoURL) + ')';
      composeAv.textContent = '';
    } else {
      composeAv.textContent = getInitials(state.user.displayName || state.user.email);
    }
  }

  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn) submitBtn.addEventListener('click', handleComposeSubmit);

  // Drive attachment
  var driveBtn = document.getElementById('driveAttachBtn');
  if (driveBtn) driveBtn.addEventListener('click', openDrivePicker);
  clearDriveAttachment();

  if (composeCircle) {
    composeCircle.innerHTML = renderCircleOptions(true);
  }

  if (composeCircle) {
    composeCircle.querySelectorAll('option').forEach(function(option) {
      option.hidden = visibleCircles.indexOf(option.value) === -1;
    });

    if (visibleCircles.indexOf(composeCircle.value) === -1) {
      composeCircle.value = 'all';
    }
  }

  if (filterPills) {
    filterPills.innerHTML = renderCirclePills();
  }

  document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
    pill.hidden = visibleCircles.indexOf(pill.dataset.filter) === -1;
  });

  document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
    pill.addEventListener('click', function() {
      feedState.filter = pill.dataset.filter;
      feedState.targetPostId = '';
      feedState.pendingTargetScroll = false;
      syncURLState();
      document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
        p.classList.toggle('active', p === pill);
      });
      syncSidebarSelection();
      renderFeedList();
    });
  });

  document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
    p.classList.toggle('active', p.dataset.filter === feedState.filter);
  });

  syncSidebarSelection();
  subscribeFeed();
};

// ─── Feed: live subscription ─────────────────────────────────────────────────
var subscribeFeed = function() {
  feedState.livePosts = [];
  feedState.olderPosts = [];
  feedState.hasMore = false;
  feedState.loadingMore = false;
  feedState.lastDoc = null;

  var q = query(
    collection(db, 'posts'),
    where('circle', 'in', getVisibleCircles(state)),
    orderBy('timestamp', 'desc'),
    limit(FEED_PAGE_SIZE)
  );

  feedState.unsubscribe = onSnapshot(q, function(snap) {
    feedState.livePosts = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      feedState.livePosts.push(data);
    });

    if (snap.empty) {
      if (feedState.olderPosts.length === 0) {
        feedState.lastDoc = null;
      }
      feedState.hasMore = false;
    } else {
      if (feedState.olderPosts.length === 0 || !feedState.lastDoc) {
        feedState.lastDoc = snap.docs[snap.docs.length - 1];
      }
      feedState.hasMore = snap.docs.length === FEED_PAGE_SIZE;
    }

    ensureTargetPostLoaded().then(function() {
      renderFeedList();
    });
  }, function(err) {
    logError('Feed subscribe error', err);
    var list = document.getElementById('feedList');
    if (list) list.innerHTML = '<div class="card"><p class="text-muted">Failed to load feed. Check Firestore rules.</p></div>';
  });
};

var getAllKnownFeedPosts = function() {
  var combined = [];
  var seen = {};

  feedState.livePosts.concat(feedState.olderPosts).forEach(function(post) {
    if (!post || !post.id || seen[post.id]) return;
    seen[post.id] = true;
    combined.push(post);
  });

  return combined;
};

var ensureTargetPostLoaded = function() {
  if (!feedState.targetPostId) return Promise.resolve(false);

  var alreadyLoaded = getAllKnownFeedPosts().some(function(post) {
    return post.id === feedState.targetPostId;
  });
  if (alreadyLoaded) return Promise.resolve(true);

  return getDoc(doc(db, 'posts', feedState.targetPostId)).then(function(snap) {
    if (!snap.exists()) return false;

    var data = snap.data() || {};
    data.id = snap.id;

    if (getVisibleCircles(state).indexOf(data.circle || 'all') === -1) {
      return false;
    }

    feedState.olderPosts = [data].concat(feedState.olderPosts.filter(function(post) {
      return post.id !== data.id;
    }));
    return true;
  }).catch(function(err) {
    logError('Failed to load shared post', err);
    return false;
  });
};

var getRenderedFeedPosts = function() {
  var combined = getAllKnownFeedPosts();

  if (feedState.filter !== 'all') {
    combined = combined.filter(function(post) {
      return post.circle === feedState.filter;
    });
  }

  // Pinned posts float to top
  var pinned = combined.filter(function(post) { return post.isPinned; });
  var unpinned = combined.filter(function(post) { return !post.isPinned; });
  combined = pinned.concat(unpinned);

  if (feedState.targetPostId) {
    var targetIndex = combined.findIndex(function(post) {
      return post.id === feedState.targetPostId;
    });

    if (targetIndex > 0) {
      var targetPost = combined.splice(targetIndex, 1)[0];
      combined.unshift(targetPost);
    }
  }

  return combined;
};

var scrollToTargetPost = function() {
  if (!feedState.targetPostId || !feedState.pendingTargetScroll) return;

  var card = document.querySelector('[data-post-id="' + feedState.targetPostId + '"]');
  if (!card) return;

  feedState.pendingTargetScroll = false;

  window.requestAnimationFrame(function() {
    card.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  });
};

var loadMoreFeedPosts = function() {
  if (feedState.loadingMore || !feedState.lastDoc) return;

  feedState.loadingMore = true;
  renderFeedList();

  var q = query(
    collection(db, 'posts'),
    where('circle', 'in', getVisibleCircles(state)),
    orderBy('timestamp', 'desc'),
    startAfter(feedState.lastDoc),
    limit(FEED_PAGE_SIZE)
  );

  getDocs(q).then(function(snap) {
    var nextPosts = [];

    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      nextPosts.push(data);
    });

    feedState.olderPosts = feedState.olderPosts.concat(nextPosts);
    feedState.hasMore = snap.docs.length === FEED_PAGE_SIZE;

    if (!snap.empty) {
      feedState.lastDoc = snap.docs[snap.docs.length - 1];
    }
  }).catch(function(err) {
    logError('Failed to load more posts', err);
    showToast('Failed to load more posts. Check console for details.', 'error');
  }).finally(function() {
    feedState.loadingMore = false;
    ensureTargetPostLoaded().then(function() {
      renderFeedList();
    });
  });
};

// ─── Feed: compose submit ────────────────────────────────────────────────────
var handleComposeSubmit = function() {
  var bodyEl   = document.getElementById('composeBody');
  var circleEl = document.getElementById('composeCircle');
  if (!bodyEl || !circleEl || !state.user) return;

  var body   = bodyEl.value.trim();
  var circle = circleEl.value;
  if (!body && !driveAttachment.fileUrl) {
    showToast('Write something or attach a file.', 'error');
    return;
  }

  var displayName = state.user.displayName || state.user.email;

  var post = {
    authorId:       state.user.uid,
    authorName:     displayName,
    authorInitials: getInitials(displayName),
    circle:         circle,
    body:           body,
    timestamp:      serverTimestamp(),
    reacts:         [],
    comments:       []
  };

  // Attach Drive file if present
  if (driveAttachment.fileUrl) {
    post.fileUrl  = driveAttachment.fileUrl;
    post.fileName = driveAttachment.fileName;
    post.fileIcon = driveAttachment.iconUrl;
  }

  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn) {
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Posting...';
  }

  var savePost = function(postData) {
    addDoc(collection(db, 'posts'), postData).then(function() {
      bodyEl.value = '';
      clearDriveAttachment();
      if (submitBtn) {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Post';
      }
    }).catch(function(err) {
      logError('Failed to post', err);
      if (submitBtn) {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Post';
      }
      showToast('Failed to post. Check console for details.', 'error');
    });
  };

  // Preserve the first URL for a local-only fallback preview card.
  var firstUrl = extractFirstUrl(body);
  if (firstUrl) {
    post.ogUrl = firstUrl;
    try {
      post.ogSite = new URL(firstUrl).hostname.replace(/^www\./, '');
    } catch (e) {}
  }

  savePost(post);
};

// ─── Feed: render list ───────────────────────────────────────────────────────
var renderFeedList = function() {
  var list = document.getElementById('feedList');
  if (!list) return;

  var posts = getRenderedFeedPosts();

  if (posts.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No posts yet</div><p class="empty-state-text">When someone shares an update, it will appear here.</p></div>';
  } else {
    list.innerHTML = posts.map(renderPostCard).join('');
  }

  if (feedState.hasMore) {
    list.insertAdjacentHTML('beforeend',
      '<div class="feed-load-more">' +
        '<button class="btn btn-ghost load-more-btn" type="button">' +
          (feedState.loadingMore ? 'Loading...' : 'Load more') +
        '</button>' +
      '</div>'
    );
  }

  list.querySelectorAll('[data-toggle-comments-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      togglePostComments(btn.dataset.toggleCommentsPost, btn.dataset.postAuthor);
    });
  });

  list.querySelectorAll('[data-comment-form]').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      handleCommentSubmit(form.dataset.commentForm, form.dataset.postAuthor, form);
    });
  });

  list.querySelectorAll('[data-react-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleReactPost(btn.dataset.reactPost);
    });
  });

  list.querySelectorAll('[data-share-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleSharePost(btn.dataset.sharePost);
    });
  });

  list.querySelectorAll('[data-delete-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleDeletePost(btn.dataset.deletePost, btn.dataset.postAuthor);
    });
  });

  list.querySelectorAll('[data-pin-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handlePinPost(btn.dataset.pinPost);
    });
  });

  var loadMoreBtn = list.querySelector('.load-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = feedState.loadingMore;
    loadMoreBtn.addEventListener('click', loadMoreFeedPosts);
  }

  scrollToTargetPost();
};

// ─── Feed: render single post card ───────────────────────────────────────────
var renderPostComments = function(postId, comments, authorId) {
  var items = comments.map(function(comment) {
    if (typeof comment === 'string') {
      return '<div class="post-comment"><div class="post-comment-body">' + escapeHTML(comment) + '</div></div>';
    }

    var commentAuthor = escapeHTML(comment.authorName || 'Member');
    var commentBody = highlightMentions(linkifyText(escapeHTML(comment.body || '')));
    var commentTime = 'just now';

    if (comment.createdAt && typeof comment.createdAt.toDate === 'function') {
      commentTime = relativeTime(comment.createdAt.toDate());
    }

    return '' +
      '<div class="post-comment">' +
        '<div class="post-comment-meta">' +
          '<span class="post-comment-author">' + commentAuthor + '</span>' +
          '<span class="post-dot">&middot;</span>' +
          '<span class="post-comment-time">' + escapeHTML(commentTime) + '</span>' +
        '</div>' +
        '<div class="post-comment-body">' + commentBody + '</div>' +
      '</div>';
  }).join('');

  if (!items) {
    items = '<div class="post-comments-empty">No comments yet.</div>';
  }

  return '' +
    '<div class="post-comments">' +
      '<div class="post-comments-list">' + items + '</div>' +
      '<form class="post-comment-compose" data-comment-form="' + escapeAttr(postId) + '" data-post-author="' + escapeAttr(authorId || '') + '">' +
        '<input class="post-comment-input" type="text" maxlength="280" placeholder="Write a comment..." data-comment-input="' + escapeAttr(postId) + '" />' +
        '<button class="btn btn-ghost post-comment-submit" type="submit">Send</button>' +
      '</form>' +
    '</div>';
};

var renderPostCard = function(p) {
  var circleLabels = {
    'all':          'All',
    'hustle-hub':   'Hustle Hub',
    'work-network': 'Work Network',
    'family':       'Family'
  };
  var circleLabel = circleLabels[p.circle] || p.circle || 'All';

  var time = (p.timestamp && typeof p.timestamp.toDate === 'function')
    ? relativeTime(p.timestamp.toDate())
    : 'just now';

  var nameEsc     = escapeHTML(p.authorName || 'Unknown');
  var initialsEsc = escapeHTML(p.authorInitials || '?');
  var bodyEsc     = highlightMentions(linkifyText(escapeHTML(p.body || '')));
  var reacts = Array.isArray(p.reacts) ? p.reacts : [];
  var comments = Array.isArray(p.comments) ? p.comments : [];
  var reacted = state.user && reacts.indexOf(state.user.uid) !== -1;
  var reactBtnClass = reacted
    ? 'post-action post-react-btn post-action-active'
    : 'post-action post-react-btn';
  var commentsOpen = !!feedState.openComments[p.id];
  var commentBtnClass = commentsOpen
    ? 'post-action post-comment-btn post-action-active'
    : 'post-action post-comment-btn';
  var canDelete = state.user && (state.isAdmin || p.authorId === state.user.uid);
  var deleteBtn = canDelete
    ? '<button class="post-action post-action-danger" data-delete-post="' + escapeAttr(p.id) + '" data-post-author="' + escapeAttr(p.authorId) + '">Delete</button>'
    : '';
  var pinBtn = state.isAdmin
    ? '<button class="post-action" data-pin-post="' + escapeAttr(p.id) + '">' + (p.isPinned ? 'Unpin' : 'Pin') + '</button>'
    : '';
  var pinnedClass = p.isPinned ? ' post-pinned' : '';
  var pinnedBadge = p.isPinned ? '<span class="post-pinned-badge">Pinned</span>' : '';

  return '' +
    '<div class="post-card' + pinnedClass + (feedState.targetPostId === p.id ? ' post-card-target' : '') + '" data-post-id="' + escapeAttr(p.id) + '">' +
      pinnedBadge +
      '<div class="post-header">' +
        '<div class="post-avatar">' + initialsEsc + '</div>' +
        '<div class="post-meta">' +
          '<div class="post-author">' + nameEsc + '</div>' +
          '<div class="post-submeta">' +
            '<span class="post-circle">' + circleLabel + '</span>' +
            '<span class="post-dot">&middot;</span>' +
            '<span class="post-time">' + time + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="post-body">' + bodyEsc + '</div>' +
      (p.ogUrl ? renderLinkPreview(p) : '') +
      (p.fileUrl
        ? '<a class="post-attachment" href="' + escapeAttr(p.fileUrl) + '" target="_blank" rel="noopener">' +
            (p.fileIcon
              ? '<img src="' + escapeAttr(p.fileIcon) + '" class="post-attachment-icon" alt="" />'
              : '<span class="post-attachment-icon-fallback">&#128196;</span>') +
            '<span class="post-attachment-name">' + escapeHTML(p.fileName || 'Attached file') + '</span>' +
            '<span class="post-attachment-open">Open &#8599;</span>' +
          '</a>'
        : '') +
      '<div class="post-actions">' +
        '<button class="' + reactBtnClass + '" data-react-post="' + escapeAttr(p.id) + '">&#128077; ' + reacts.length + '</button>' +
        '<button class="' + commentBtnClass + '" data-toggle-comments-post="' + escapeAttr(p.id) + '" data-post-author="' + escapeAttr(p.authorId) + '">&#128172; ' + comments.length + '</button>' +
        '<button class="post-action" data-share-post="' + escapeAttr(p.id) + '">&#8599; Share</button>' +
        pinBtn +
        deleteBtn +
      '</div>' +
      (commentsOpen ? renderPostComments(p.id, comments, p.authorId) : '') +
    '</div>';
};

var handleSharePost = function(postId) {
  var post = getAllKnownFeedPosts().find(function(item) {
    return item.id === postId;
  });
  if (!post) return;

  var author = post.authorName || 'Someone';
  var body = String(post.body || '').trim();
  var summary = body.length > 140
    ? body.slice(0, 137) + '...'
    : body;
  var shareURL = getAppURL() + '?page=feed&postId=' + encodeURIComponent(postId);
  var shareText = author + ' in Enclave: ' + summary;

  if (navigator.share) {
    navigator.share({
      title: 'Enclave Post',
      text: shareText,
      url: shareURL
    }).catch(function() {
      // Ignore cancelled shares.
    });
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareText + '\n\n' + shareURL).then(function() {
      showToast('Post link copied.', 'success');
    }).catch(function(err) {
      logError('Failed to copy share text', err);
      showToast('Unable to share this post right now.', 'error');
    });
    return;
  }

  showNoticeModal('Share this post', shareText + '\n\n' + shareURL);
};

var updateKnownPostReacts = function(postId, reacts) {
  [feedState.livePosts, feedState.olderPosts].forEach(function(posts) {
    posts.forEach(function(post) {
      if (post.id === postId) {
        post.reacts = reacts.slice();
      }
    });
  });
};

var updateKnownPostComments = function(postId, comments) {
  [feedState.livePosts, feedState.olderPosts].forEach(function(posts) {
    posts.forEach(function(post) {
      if (post.id === postId) {
        post.comments = comments.slice();
      }
    });
  });
};

var togglePostComments = function(postId, authorId) {
  if (!postId) return;

  feedState.openComments[postId] = !feedState.openComments[postId];
  renderFeedList();

  if (authorId && document.getElementById('profilePosts')) {
    loadProfileRecentPosts(authorId);
  }
};

var handleReactPost = function(postId) {
  if (!state.user) return;

  var ref = doc(db, 'posts', postId);
  var post = getAllKnownFeedPosts().find(function(item) {
    return item.id === postId;
  });
  var authorId = post && post.authorId ? post.authorId : null;
  var nextReacts = null;
  var uid = state.user.uid;

  runTransaction(db, function(tx) {
    return tx.get(ref).then(function(snap) {
      if (!snap.exists()) return;

      var current = Array.isArray(snap.data().reacts) ? snap.data().reacts.slice() : [];
      var idx = current.indexOf(uid);

      if (idx === -1) {
        current.push(uid);
      } else {
        current.splice(idx, 1);
      }

      nextReacts = current.slice();
      tx.update(ref, { reacts: current });
    });
  }).then(function() {
    if (!nextReacts) return;

    updateKnownPostReacts(postId, nextReacts);
    renderFeedList();

    if (authorId && document.getElementById('profilePosts')) {
      loadProfileRecentPosts(authorId);
    }
  }).catch(function(err) {
    logError('React failed', err);
    showToast('Could not save reaction. Try again.', 'error');
  });
};

var handleCommentSubmit = function(postId, authorId, formEl) {
  if (!state.user || !postId) return;

  var input = formEl
    ? formEl.querySelector('[data-comment-input]')
    : document.querySelector('[data-comment-input="' + postId + '"]');
  if (!input) return;

  var body = input.value.trim();
  if (!body) return;

  var ref = doc(db, 'posts', postId);
  var nextComments = null;
  var comment = {
    uid: state.user.uid,
    authorName: state.user.displayName || state.user.email || 'Member',
    body: body,
    createdAt: Timestamp.now()
  };

  input.disabled = true;

  runTransaction(db, function(tx) {
    return tx.get(ref).then(function(snap) {
      if (!snap.exists()) return;

      var current = Array.isArray(snap.data().comments) ? snap.data().comments.slice() : [];
      current.push(comment);
      nextComments = current.slice();
      tx.update(ref, { comments: current });
    });
  }).then(function() {
    if (!nextComments) return;

    updateKnownPostComments(postId, nextComments);
    feedState.openComments[postId] = true;
    renderFeedList();

    // Notify post author about the comment
    if (authorId && authorId !== state.user.uid) {
      var actor = state.user.displayName || state.user.email || 'Member';
      writeNotification(authorId, 'post-comment', actor + ' commented on your post', { page: 'feed', params: { postId: postId } });
    }

    if (authorId && document.getElementById('profilePosts')) {
      loadProfileRecentPosts(authorId);
    }
  }).catch(function(err) {
    logError('Comment failed', err);
    showToast('Could not save comment. Try again.', 'error');
  }).finally(function() {
    input.disabled = false;
  });
};

var handleDeletePost = function(postId, authorId) {
  if (!postId) return;

  showConfirmModal('Delete post', 'Delete this post?', 'Delete').then(function(confirmed) {
    if (!confirmed) return;

    deleteDoc(doc(db, 'posts', postId)).then(function() {
      if (authorId && document.getElementById('profilePosts')) {
        loadProfileRecentPosts(authorId);
      }
      showToast('Post deleted.', 'success');
    }).catch(function(err) {
      logError('Failed to delete post', err);
      showToast('Failed to delete post. Check console for details.', 'error');
    });
  });
};

var handlePinPost = function(postId) {
  if (!postId || !state.isAdmin) return;
  var post = getAllKnownFeedPosts().find(function(p) { return p.id === postId; });
  if (!post) return;
  var newPinned = !post.isPinned;
  updateDoc(doc(db, 'posts', postId), { isPinned: newPinned }).then(function() {
    post.isPinned = newPinned;
    renderFeedList();
    showToast(newPinned ? 'Post pinned.' : 'Post unpinned.', 'info');
  }).catch(function(err) {
    logError('Pin post error', err);
    showToast('Failed to pin post.', 'error');
  });
};

// ─── Members: recent posts for profile modal ─────────────────────────────────
export const loadProfileRecentPosts = function(uid) {
  var container = document.getElementById('profilePosts');
  if (!container) return;

  var q = query(
    collection(db, 'posts'),
    where('authorId', '==', uid),
    where('circle', 'in', getVisibleCircles(state)),
    orderBy('timestamp', 'desc'),
    limit(5)
  );

  getDocs(q).then(function(snap) {
    var posts = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      posts.push(data);
    });

    if (posts.length === 0) {
      container.innerHTML = '<p class="text-muted">No posts yet.</p>';
      return;
    }

    container.innerHTML = posts.map(renderPostCard).join('');

    container.querySelectorAll('[data-share-post]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        handleSharePost(btn.dataset.sharePost);
      });
    });

    container.querySelectorAll('[data-toggle-comments-post]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        togglePostComments(btn.dataset.toggleCommentsPost, btn.dataset.postAuthor);
      });
    });

    container.querySelectorAll('[data-comment-form]').forEach(function(form) {
      form.addEventListener('submit', function(e) {
        e.preventDefault();
        handleCommentSubmit(form.dataset.commentForm, form.dataset.postAuthor, form);
      });
    });

    container.querySelectorAll('[data-react-post]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        handleReactPost(btn.dataset.reactPost);
      });
    });

    container.querySelectorAll('[data-delete-post]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        handleDeletePost(btn.dataset.deletePost, btn.dataset.postAuthor);
      });
    });
  }).catch(function(err) {
    logError('Failed to load recent posts', err);
    // If it's a missing-index error, Firestore returns a specific message
    var msg = err && err.message && err.message.indexOf('index') !== -1
      ? 'Posts query needs a Firestore index. Check browser console for a link to create it.'
      : 'Failed to load posts.';
    container.innerHTML = '<p class="text-muted">' + msg + '</p>';
  });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
var getCircleDefinitions = function() {
  return [
    { id: 'hustle-hub',   label: 'Hustle Hub' },
    { id: 'work-network', label: 'Work Network' },
    { id: 'family',       label: 'Family' }
  ];
};

var renderCirclePills = function() {
  return '<button class="pill active" data-filter="all">All</button>' +
    getCircleDefinitions().map(function(circle) {
      return '<button class="pill" data-filter="' + circle.id + '">' + escapeHTML(circle.label) + '</button>';
    }).join('');
};

// ─── URL detection & link preview ────────────────────────────────────────────
var renderLinkPreview = function(og) {
  if (!og || !og.ogUrl) return '';

  // Fallback card: no title means Microlink couldn't fetch preview
  if (!og.ogTitle) {
    var domain = '';
    try { domain = new URL(og.ogUrl).hostname.replace(/^www\./, ''); } catch(e) { domain = og.ogUrl; }
    return '' +
      '<a class="link-preview-card link-preview-fallback" href="' + escapeAttr(og.ogUrl) + '" target="_blank" rel="noopener">' +
        '<div class="link-preview-text">' +
          '<span class="link-preview-site">&#128279; ' + escapeHTML(domain) + '</span>' +
          '<span class="link-preview-title">' + escapeHTML(og.ogUrl) + '</span>' +
        '</div>' +
      '</a>';
  }

  var img = og.ogImage
    ? '<img class="link-preview-img" src="' + escapeAttr(og.ogImage) + '" alt="" />'
    : '';
  var site = og.ogSite
    ? '<span class="link-preview-site">' + escapeHTML(og.ogSite) + '</span>'
    : '';
  return '' +
    '<a class="link-preview-card" href="' + escapeAttr(og.ogUrl) + '" target="_blank" rel="noopener">' +
      img +
      '<div class="link-preview-text">' +
        site +
        '<span class="link-preview-title">' + escapeHTML(og.ogTitle) + '</span>' +
        (og.ogDescription
          ? '<span class="link-preview-desc">' + escapeHTML(og.ogDescription.substring(0, 150)) + '</span>'
          : '') +
      '</div>' +
    '</a>';
};
