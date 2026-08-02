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
  arrayUnion,
  arrayRemove,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, feedState, driveAttachment } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr, extractFirstUrl, renderRichText, sanitizeRichHTML } from '../util/escape.js';
import { relativeTime } from '../util/time.js';
import { getVisibleCircles, getInitials, renderCircleOptions, circleLabel } from '../util/circles.js';
import { FEED_PAGE_SIZE, ALL_CIRCLES } from '../util/constants.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { showConfirmModal, showNoticeModal } from '../ui/modals.js';
import { openDrivePicker, clearDriveAttachment } from '../ui/drivePicker.js';
import {
  initPhotoAttach,
  clearPhotoAttachments,
  getPendingPhotoCount,
  uploadPendingPhotos,
  renderPostImages,
  wireLightboxButtons
} from '../ui/photoAttach.js';

// Cross-page
import { writeNotification } from './notifications.js';

// Shell bridge
import { syncSidebarSelection, syncURLState, getAppURL } from '../util/shell-bridge.js';

var composeDraftTimer = null;
var COMPOSE_DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
var pendingPostSaves = {};

var getComposeDraftKey = function() {
  return state.user ? 'enclave_feed_draft_' + state.user.uid : '';
};

var setComposeDraftStatus = function(message) {
  var status = document.getElementById('composeDraftStatus');
  if (status) status.textContent = message || '';
};

var clearComposeDraft = function() {
  var key = getComposeDraftKey();
  if (!key) return;
  try { localStorage.removeItem(key); } catch (err) {}
};

var saveComposeDraft = function() {
  if (composeDraftTimer) {
    window.clearTimeout(composeDraftTimer);
    composeDraftTimer = null;
  }
  var bodyEl = document.getElementById('composeBody');
  var circleEl = document.getElementById('composeCircle');
  var key = getComposeDraftKey();
  if (!bodyEl || !circleEl || !key) return;

  if (!bodyEl.value.trim()) {
    clearComposeDraft();
    setComposeDraftStatus('');
    return;
  }

  try {
    localStorage.setItem(key, JSON.stringify({
      body: bodyEl.value,
      circle: circleEl.value,
      savedAt: Date.now()
    }));
    setComposeDraftStatus('Text draft saved on this device');
  } catch (err) {
    setComposeDraftStatus('Draft could not be saved');
  }
};

var queueComposeDraftSave = function() {
  if (composeDraftTimer) window.clearTimeout(composeDraftTimer);
  setComposeDraftStatus('Saving draft...');
  composeDraftTimer = window.setTimeout(function() {
    composeDraftTimer = null;
    saveComposeDraft();
  }, 500);
};

var restoreComposeDraft = function(visibleCircles) {
  var bodyEl = document.getElementById('composeBody');
  var circleEl = document.getElementById('composeCircle');
  var key = getComposeDraftKey();
  if (!bodyEl || !circleEl || !key) return;

  try {
    var raw = localStorage.getItem(key);
    if (!raw) return;
    var draft = JSON.parse(raw);
    if (!draft || typeof draft.body !== 'string' || !draft.body.trim() ||
        !draft.savedAt || Date.now() - draft.savedAt > COMPOSE_DRAFT_MAX_AGE) {
      clearComposeDraft();
      return;
    }
    bodyEl.value = draft.body;
    if (visibleCircles.indexOf(draft.circle) !== -1) circleEl.value = draft.circle;
    setComposeDraftStatus('Text draft restored from this device');
  } catch (err) {
    clearComposeDraft();
  }
};

// ─── Feed: init ──────────────────────────────────────────────────────────────
export const initFeedPage = function() {
  var visibleCircles = getVisibleCircles(state);
  var composeCircle = document.getElementById('composeCircle');
  var filterPills = document.querySelector('.filter-pills');

  if (feedState.filter !== 'saved' && visibleCircles.indexOf(feedState.filter) === -1) {
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

  var bodyEl = document.getElementById('composeBody');
  if (bodyEl) {
    bodyEl.addEventListener('input', queueComposeDraftSave);
    bodyEl.addEventListener('blur', saveComposeDraft);
    bodyEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleComposeSubmit();
      }
    });
  }

  document.querySelectorAll('[data-compose-prompt]').forEach(function(prompt) {
    prompt.addEventListener('click', function() {
      if (!bodyEl) return;
      var starter = prompt.dataset.composePrompt || '';
      if (!bodyEl.value.trim()) {
        bodyEl.value = starter;
      } else {
        bodyEl.value = bodyEl.value.replace(/\s*$/, '\n\n') + starter;
      }
      bodyEl.focus();
      bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length);
      queueComposeDraftSave();
    });
  });

  // Drive attachment
  var driveBtn = document.getElementById('driveAttachBtn');
  if (driveBtn) driveBtn.addEventListener('click', openDrivePicker);
  clearDriveAttachment();

  var htmlBtn = document.getElementById('htmlImportBtn');
  var htmlInput = document.getElementById('htmlFileInput');
  if (htmlBtn && htmlInput) {
    htmlBtn.addEventListener('click', function() {
      htmlInput.click();
    });
    htmlInput.addEventListener('change', handleHtmlFileImport);
  }

  // Photo attachments
  initPhotoAttach();

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
    composeCircle.addEventListener('change', queueComposeDraftSave);
  }

  restoreComposeDraft(visibleCircles);

  if (filterPills) {
    filterPills.innerHTML = renderCirclePills();
  }

  document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
    pill.hidden = pill.dataset.filter !== 'saved' && visibleCircles.indexOf(pill.dataset.filter) === -1;
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
      if (feedState.filter === 'saved') {
        ensureSavedPostsLoaded().then(renderFeedList);
      } else {
        renderFeedList();
      }
    });
  });

  document.querySelectorAll('.filter-pills .pill').forEach(function(p) {
    p.classList.toggle('active', p.dataset.filter === feedState.filter);
  });

  syncSidebarSelection();
  subscribeFeed();
  loadSavedPosts().then(function() {
    if (state.currentPage !== 'feed') return null;
    return feedState.filter === 'saved' ? ensureSavedPostsLoaded() : null;
  }).then(function() {
    if (state.currentPage === 'feed') renderFeedList();
  });
};

var loadSavedPosts = function() {
  feedState.savedPostsLoaded = false;
  if (!state.user) return Promise.resolve();

  return getDoc(doc(db, 'users', state.user.uid)).then(function(snap) {
    var data = snap.exists() ? (snap.data() || {}) : {};
    var saved = Array.isArray(data.savedPosts) ? data.savedPosts : [];
    feedState.savedPosts = saved.filter(function(id, index) {
      return typeof id === 'string' && saved.indexOf(id) === index;
    });
    feedState.savedPostsLoaded = true;
  }).catch(function(err) {
    logError('Failed to load saved posts', err);
    showToast('Saved posts could not be loaded.', 'error');
  });
};

var ensureSavedPostsLoaded = function() {
  var known = {};
  getAllKnownFeedPosts().forEach(function(post) { known[post.id] = true; });
  var missing = feedState.savedPosts.filter(function(id) { return !known[id]; });
  if (missing.length === 0) return Promise.resolve();

  return Promise.all(missing.map(function(id) {
    return getDoc(doc(db, 'posts', id)).then(function(snap) {
      if (!snap.exists()) return null;
      var post = snap.data() || {};
      post.id = snap.id;
      return getVisibleCircles(state).indexOf(post.circle || 'all') !== -1 ? post : null;
    }).catch(function(err) {
      logError('Failed to load saved post', err);
      return null;
    });
  })).then(function(posts) {
    var loaded = posts.filter(Boolean);
    feedState.olderPosts = loaded.concat(feedState.olderPosts.filter(function(post) {
      return !loaded.some(function(savedPost) { return savedPost.id === post.id; });
    }));
  });
};

// ─── Feed: HTML import ────────────────────────────────────────────────────────
var extractHtmlBody = function(html) {
  var source = String(html == null ? '' : html);

  try {
    var parsed = new DOMParser().parseFromString(source, 'text/html');
    if (!parsed || !parsed.body) return source;

    var article = parsed.querySelector('article');
    var main = parsed.querySelector('main');
    var content = document.createElement('div');

    if (article) {
      var title = parsed.querySelector('main h1, h1');
      if (title) {
        content.appendChild(title.cloneNode(true));
      } else if (parsed.title) {
        var h1 = document.createElement('h1');
        h1.textContent = parsed.title;
        content.appendChild(h1);
      }
      content.appendChild(article.cloneNode(true));
    } else if (main) {
      content.appendChild(main.cloneNode(true));
    } else {
      content.innerHTML = parsed.body.innerHTML;
    }

    content.querySelectorAll([
      'aside',
      'button',
      'canvas',
      'footer',
      'form',
      'header',
      'input',
      'nav',
      'script',
      'select',
      'style',
      'svg',
      'textarea'
    ].join(',')).forEach(function(el) {
      el.remove();
    });

    return content.innerHTML.trim() || source;
  } catch (err) {}

  return source;
};

var handleHtmlFileImport = function(evt) {
  var input = evt && evt.currentTarget;
  var file = input && input.files && input.files[0];
  var bodyEl = document.getElementById('composeBody');
  if (!file || !bodyEl) return;

  if (!/\.html?$/i.test(file.name || '') && file.type && file.type !== 'text/html') {
    showToast('Choose an HTML file.', 'error');
    input.value = '';
    return;
  }

  file.text().then(function(source) {
    var html = sanitizeRichHTML(extractHtmlBody(source)).trim();
    if (!html) {
      showToast('No feed-safe HTML found in that file.', 'error');
      return;
    }

    bodyEl.value = bodyEl.value.trim()
      ? bodyEl.value.trim() + '\n\n' + html
      : html;
    bodyEl.focus();
    queueComposeDraftSave();
    showToast('HTML imported into the composer.', 'success');
  }).catch(function(err) {
    logError('Failed to import HTML file', err);
    showToast('Failed to import HTML file.', 'error');
  }).finally(function() {
    input.value = '';
  });
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
      if (feedState.filter === 'saved' && !feedState.savedPostsLoaded) return null;
      return feedState.filter === 'saved' ? ensureSavedPostsLoaded() : null;
    }).then(function() {
      if (feedState.filter !== 'saved' || feedState.savedPostsLoaded) renderFeedList();
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

  if (feedState.filter === 'saved') {
    combined = combined.filter(function(post) {
      return feedState.savedPosts.indexOf(post.id) !== -1;
    });
  } else if (feedState.filter !== 'all') {
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

  var submitBtn = document.getElementById('composeSubmit');
  if (submitBtn && submitBtn.disabled) return;

  var body   = bodyEl.value.trim();
  var circle = circleEl.value;
  if (!body && !driveAttachment.fileUrl && getPendingPhotoCount() === 0) {
    showToast('Write something, add photos, or attach a file.', 'error');
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

  var hasPhotos = getPendingPhotoCount() > 0;
  if (submitBtn) {
    submitBtn.disabled    = true;
    submitBtn.textContent = hasPhotos ? 'Uploading...' : 'Posting...';
  }

  var restoreSubmit = function() {
    if (submitBtn) {
      submitBtn.disabled    = false;
      submitBtn.textContent = 'Post';
    }
  };

  var savePost = function(postData) {
    addDoc(collection(db, 'posts'), postData).then(function() {
      bodyEl.value = '';
      if (composeDraftTimer) {
        window.clearTimeout(composeDraftTimer);
        composeDraftTimer = null;
      }
      clearComposeDraft();
      setComposeDraftStatus('Posted successfully');
      clearDriveAttachment();
      clearPhotoAttachments();
      restoreSubmit();
      showToast('Posted to ' + circleLabel(circle) + '.', 'success');
    }).catch(function(err) {
      logError('Failed to post', err);
      restoreSubmit();
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

  uploadPendingPhotos().then(function(images) {
    if (images.length > 0) {
      post.images = images;
    }
    if (submitBtn) submitBtn.textContent = 'Posting...';
    savePost(post);
  }).catch(function(err) {
    logError('Photo upload failed', err);
    restoreSubmit();
    showToast('Photo upload failed. Try again.', 'error');
  });
};

// ─── Feed: render list ───────────────────────────────────────────────────────
var renderFeedList = function() {
  var list = document.getElementById('feedList');
  if (!list) return;

  var posts = getRenderedFeedPosts();

  var drafts = {};
  list.querySelectorAll('[data-comment-input]').forEach(function(input) {
    var pid = input.dataset.commentInput;
    if (pid && input.value) drafts[pid] = input.value;
  });

  if (posts.length === 0) {
    var isSavedView = feedState.filter === 'saved';
    var emptyTitle = isSavedView ? 'Nothing saved yet' : (feedState.filter === 'all' ? 'Start the conversation' : 'Nothing shared here yet');
    var emptyText = isSavedView
      ? 'Save useful posts to build a private reading list you can return to anytime.'
      : (feedState.filter === 'all'
      ? 'Share a useful insight, ask for advice, or offer help to your network.'
      : 'Be the first to share something with ' + circleLabel(feedState.filter) + '.');
    list.innerHTML = '<div class="empty-state feed-empty-state">' +
      '<div class="feed-empty-mark" aria-hidden="true">' + (isSavedView ? '&#9734;' : '+') + '</div>' +
      '<div class="empty-state-title">' + escapeHTML(emptyTitle) + '</div>' +
      '<p class="empty-state-text">' + escapeHTML(emptyText) + '</p>' +
      (isSavedView
        ? '<button type="button" class="btn btn-primary" data-show-all-feed>Browse the feed</button>'
        : '<button type="button" class="btn btn-primary feed-empty-compose" data-focus-composer>Write a post</button>') +
    '</div>';
  } else {
    list.innerHTML = posts.map(renderPostCard).join('');
  }

  var focusComposerBtn = list.querySelector('[data-focus-composer]');
  if (focusComposerBtn) {
    focusComposerBtn.addEventListener('click', function() {
      var composer = document.getElementById('composeBody');
      if (!composer) return;
      var composeCircle = document.getElementById('composeCircle');
      if (composeCircle && feedState.filter !== 'all') {
        composeCircle.value = feedState.filter;
      }
      composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(function() { composer.focus(); }, 250);
    });
  }

  var showAllBtn = list.querySelector('[data-show-all-feed]');
  if (showAllBtn) {
    showAllBtn.addEventListener('click', function() {
      feedState.filter = 'all';
      syncURLState();
      document.querySelectorAll('.filter-pills .pill').forEach(function(pill) {
        pill.classList.toggle('active', pill.dataset.filter === 'all');
      });
      renderFeedList();
    });
  }

  if (feedState.hasMore && feedState.filter !== 'saved') {
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

  list.querySelectorAll('[data-save-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      handleSavePost(btn.dataset.savePost);
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

  wireLightboxButtons(list, function(postId) {
    var post = getAllKnownFeedPosts().find(function(item) {
      return item.id === postId;
    });
    return post ? post.images : [];
  });

  var loadMoreBtn = list.querySelector('.load-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = feedState.loadingMore;
    loadMoreBtn.addEventListener('click', loadMoreFeedPosts);
  }

  scrollToTargetPost();

  Object.keys(drafts).forEach(function(pid) {
    var input = list.querySelector('[data-comment-input="' + pid + '"]');
    if (input) input.value = drafts[pid];
  });
};

// ─── Feed: render single post card ───────────────────────────────────────────
var renderPostComments = function(postId, comments, authorId) {
  var items = comments.map(function(comment) {
    if (typeof comment === 'string') {
      return '<div class="post-comment"><div class="post-comment-body">' + renderRichText(comment) + '</div></div>';
    }

    var commentAuthor = escapeHTML(comment.authorName || 'Member');
    var commentBody = renderRichText(comment.body || '');
    var commentTime = 'just now';

    if (comment.createdAt && typeof comment.createdAt.toDate === 'function') {
      commentTime = relativeTime(comment.createdAt.toDate());
    }

    var commentInitials = comment.authorName ? getInitials(comment.authorName) : '?';
    return '' +
      '<div class="post-comment">' +
        '<div class="post-comment-avatar">' + escapeHTML(commentInitials) + '</div>' +
        '<div class="post-comment-content">' +
          '<div class="post-comment-meta">' +
            '<span class="post-comment-author">' + commentAuthor + '</span>' +
            '<span class="post-dot">&middot;</span>' +
            '<span class="post-comment-time">' + escapeHTML(commentTime) + '</span>' +
          '</div>' +
          '<div class="post-comment-body">' + commentBody + '</div>' +
        '</div>' +
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

var renderPostCard = function(p, context) {
  var circleLabelText = p.circle === 'all'
    ? 'All'
    : circleLabel(p.circle || 'all');

  var time = (p.timestamp && typeof p.timestamp.toDate === 'function')
    ? relativeTime(p.timestamp.toDate())
    : 'just now';

  var nameEsc     = escapeHTML(p.authorName || 'Unknown');
  var initialsEsc = escapeHTML(p.authorInitials || '?');
  var bodyEsc     = renderRichText(p.body || '');
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
  var isSaved = feedState.savedPosts.indexOf(p.id) !== -1;
  var savePending = !!pendingPostSaves[p.id];
  var saveBtn = context === 'profile' ? '' :
    '<button class="post-action post-save-btn' + (isSaved ? ' post-action-active' : '') + '" data-save-post="' + escapeAttr(p.id) + '" aria-label="' + (isSaved ? 'Remove from saved posts' : 'Save post') + '" aria-pressed="' + (isSaved ? 'true' : 'false') + '"' + ((!feedState.savedPostsLoaded || savePending) ? ' disabled' : '') + '>' +
      '<span class="post-save-icon" aria-hidden="true">' + (isSaved ? '&#9733;' : '&#9734;') + '</span>' +
      '<span class="post-action-label">' + (isSaved ? 'Saved' : 'Save') + '</span>' +
    '</button>';
  var canDelete = state.user && (state.isAdmin || p.authorId === state.user.uid);
  var deleteBtn = canDelete
    ? '<button class="post-action post-action-danger" data-delete-post="' + escapeAttr(p.id) + '" data-post-author="' + escapeAttr(p.authorId) + '" aria-label="Delete post">' +
        '<svg class="post-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M3 6h18"></path>' +
          '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>' +
          '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
        '</svg>' +
      '</button>'
    : '';
  var pinBtn = state.isAdmin
    ? '<button class="post-action" data-pin-post="' + escapeAttr(p.id) + '" aria-label="' + (p.isPinned ? 'Unpin' : 'Pin') + '">' +
        '<svg class="post-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<line x1="12" y1="17" x2="12" y2="22"></line>' +
          '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>' +
        '</svg>' +
        '<span class="post-action-label">' + (p.isPinned ? 'Unpin' : 'Pin') + '</span>' +
      '</button>'
    : '';
  var pinnedClass = p.isPinned ? ' post-pinned' : '';
  var pinnedBadge = p.isPinned
    ? '<span class="post-pinned-badge">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<line x1="12" y1="17" x2="12" y2="22"></line>' +
          '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>' +
        '</svg>' +
        'Pinned' +
      '</span>'
    : '';

  return '' +
    '<div class="post-card' + pinnedClass + (feedState.targetPostId === p.id ? ' post-card-target' : '') + '" data-post-id="' + escapeAttr(p.id) + '">' +
      pinnedBadge +
      '<div class="post-header">' +
        '<div class="post-avatar">' + initialsEsc + '</div>' +
        '<div class="post-meta">' +
          '<div class="post-author">' + nameEsc + '</div>' +
          '<div class="post-submeta">' +
            '<span class="post-circle">' + circleLabelText + '</span>' +
            '<span class="post-dot">&middot;</span>' +
            '<span class="post-time">' + time + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="post-body">' + bodyEsc + '</div>' +
      renderPostImages(p) +
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
        '<button class="' + reactBtnClass + '" data-react-post="' + escapeAttr(p.id) + '" aria-label="React">' +
          '<svg class="post-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M7 10v12"></path>' +
            '<path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"></path>' +
          '</svg>' +
          '<span class="post-action-count">' + reacts.length + '</span>' +
        '</button>' +
        '<button class="' + commentBtnClass + '" data-toggle-comments-post="' + escapeAttr(p.id) + '" data-post-author="' + escapeAttr(p.authorId) + '" aria-label="Comments">' +
          '<svg class="post-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>' +
          '</svg>' +
          '<span class="post-action-count">' + comments.length + '</span>' +
        '</button>' +
        '<button class="post-action" data-share-post="' + escapeAttr(p.id) + '" aria-label="Share">' +
          '<svg class="post-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>' +
            '<polyline points="16 6 12 2 8 6"></polyline>' +
            '<line x1="12" y1="2" x2="12" y2="15"></line>' +
          '</svg>' +
          '<span class="post-action-label">Share</span>' +
        '</button>' +
        saveBtn +
        pinBtn +
        deleteBtn +
      '</div>' +
      (commentsOpen ? renderPostComments(p.id, comments, p.authorId) : '') +
    '</div>';
};

var handleSavePost = function(postId) {
  if (!state.user || !postId || !feedState.savedPostsLoaded || pendingPostSaves[postId]) return;

  var previous = feedState.savedPosts.slice();
  var next = previous.slice();
  var index = next.indexOf(postId);
  var isRemoving = index !== -1;
  if (isRemoving) {
    next.splice(index, 1);
  } else {
    next.push(postId);
  }

  pendingPostSaves[postId] = true;
  feedState.savedPosts = next;
  renderFeedList();

  updateDoc(doc(db, 'users', state.user.uid), {
    savedPosts: isRemoving ? arrayRemove(postId) : arrayUnion(postId)
  }).then(function() {
    delete pendingPostSaves[postId];
    renderFeedList();
    showToast(isRemoving ? 'Removed from saved posts.' : 'Saved for later.', 'success');
  }).catch(function(err) {
    logError('Failed to update saved posts', err);
    delete pendingPostSaves[postId];
    var current = feedState.savedPosts.slice();
    var currentIndex = current.indexOf(postId);
    if (isRemoving && currentIndex === -1) current.push(postId);
    if (!isRemoving && currentIndex !== -1) current.splice(currentIndex, 1);
    feedState.savedPosts = current;
    renderFeedList();
    showToast('Could not update saved posts.', 'error');
  });
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

    var justClickedBtn = document.querySelector('[data-react-post="' + postId + '"]');
    if (justClickedBtn && justClickedBtn.classList.contains('post-action-active')) {
      justClickedBtn.classList.add('post-react-just-clicked');
      setTimeout(function() {
        justClickedBtn.classList.remove('post-react-just-clicked');
      }, 400);
    }

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

    container.innerHTML = posts.map(function(post) { return renderPostCard(post, 'profile'); }).join('');

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

    wireLightboxButtons(container, function(postId) {
      var post = posts.find(function(item) { return item.id === postId; });
      return post ? post.images : [];
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
var renderCirclePills = function() {
  return '<button class="pill active" data-filter="all">All</button>' +
    '<button class="pill feed-saved-pill" data-filter="saved"><span aria-hidden="true">&#9733;</span> Saved</button>' +
    ALL_CIRCLES.map(function(id) {
      return '<button class="pill" data-filter="' + escapeAttr(id) + '">' + escapeHTML(circleLabel(id)) + '</button>';
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
