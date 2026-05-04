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
  onSnapshot,
  getDocs,
  serverTimestamp,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import {
  state,
  membersState,
  projectsState,
  pickerState,
  resetProjectDetailState
} from '../state.js';

// Utilities
import { escapeHTML, escapeAttr, linkifyText, highlightMentions } from '../util/escape.js';
import { relativeTime, getFirestoreTimeMs } from '../util/time.js';
import { getInitials } from '../util/circles.js';
import { STRATEGY_APP_URL } from '../util/constants.js';
import { logError } from '../util/log.js';

// Shell bridge
import { syncURLState, syncSidebarSelection, loadPage } from '../util/shell-bridge.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { showConfirmModal } from '../ui/modals.js';
import { openDrivePicker, registerPickerHandler } from '../ui/drivePicker.js';

// Cross-page
import { writeNotification } from './notifications.js';

var statusLabel = function(status) {
  var labels = {
    'active':    'Active',
    'on-hold':   'On Hold',
    'completed': 'Completed'
  };
  return labels[status] || status || 'Active';
};

// ─── Modal pending-invites state ────────────────────────────────────────────
var modalPendingInvites = [];

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

var renderModalPendingInvitesList = function() {
  var listEl = document.getElementById('projectPendingInvitesList');
  if (!listEl) return;
  if (modalPendingInvites.length === 0) {
    listEl.innerHTML = '<span class="text-muted" style="font-size:11px;">No pending invites yet.</span>';
    return;
  }
  listEl.innerHTML = modalPendingInvites.map(function(email, idx) {
    return '<span class="pending-invite-chip">' +
      escapeHTML(email) +
      '<button type="button" class="pending-invite-chip-remove" data-remove-pending="' + idx + '" aria-label="Remove">\xd7</button>' +
    '</span>';
  }).join('');
  listEl.querySelectorAll('[data-remove-pending]').forEach(function(btn) {
    btn.onclick = function() {
      var idx = parseInt(btn.dataset.removePending, 10);
      modalPendingInvites.splice(idx, 1);
      renderModalPendingInvitesList();
    };
  });
};

// ─── Drive picker handler ────────────────────────────────────────────────────

registerPickerHandler('project', function(file) {
  if (!pickerState.projectId) return false;

  handleProjectFileAttach(pickerState.projectId, {
    fileUrl:     file.url || '',
    fileName:    file.name || 'Attached file',
    iconUrl:     file.iconUrl || '',
    addedBy:     state.user.uid,
    addedByName: state.user.displayName || state.user.email || 'Member',
    addedAt:     Timestamp.now()
  });
  pickerState.context = null;
  pickerState.projectId = null;
  return true;
});

// ─── Internal helpers ────────────────────────────────────────────────────────

var sortProjectsByUpdatedAt = function(items) {
  return items.sort(function(a, b) {
    return getFirestoreTimeMs(b.updatedAt || b.createdAt) - getFirestoreTimeMs(a.updatedAt || a.createdAt);
  });
};

var getProjectCommentsForRender = function(p) {
  return projectsState.activeProjectId === p.id
    ? projectsState.detailComments.slice()
    : [];
};

var getProjectFilesForRender = function(p) {
  return projectsState.activeProjectId === p.id
    ? projectsState.detailFiles.slice()
    : [];
};

var getProjectTasksForRender = function(p) {
  return projectsState.activeProjectId === p.id
    ? projectsState.detailTasks.slice()
    : [];
};

var refreshProjectDetailView = function() {
  // Don't re-render if user is editing a task inline
  var detailEl = document.getElementById('projectDetail');
  if (detailEl && detailEl.querySelector('.task-edit-form')) return;
  if (projectsState.detailProject) {
    renderProjectDetail(projectsState.detailProject);
  }
};

var subscribeProjectCollections = function(projectId) {
  if (projectsState.commentsUnsubscribe) {
    projectsState.commentsUnsubscribe();
    projectsState.commentsUnsubscribe = null;
  }

  if (projectsState.filesUnsubscribe) {
    projectsState.filesUnsubscribe();
    projectsState.filesUnsubscribe = null;
  }

  if (projectsState.tasksUnsubscribe) {
    projectsState.tasksUnsubscribe();
    projectsState.tasksUnsubscribe = null;
  }

  projectsState.detailComments = [];
  projectsState.detailFiles = [];
  projectsState.detailTasks = [];

  projectsState.commentsUnsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'comments'), orderBy('createdAt', 'asc')),
    function(snap) {
      projectsState.detailComments = [];
      snap.forEach(function(d) {
        var data = d.data();
        data.id = d.id;
        projectsState.detailComments.push(data);
      });
      refreshProjectDetailView();
    },
    function(err) {
      logError('Project comments error', err);
    }
  );

  projectsState.filesUnsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'files'), orderBy('addedAt', 'desc')),
    function(snap) {
      projectsState.detailFiles = [];
      snap.forEach(function(d) {
        var data = d.data();
        data.id = d.id;
        projectsState.detailFiles.push(data);
      });
      refreshProjectDetailView();
    },
    function(err) {
      logError('Project files error', err);
    }
  );

  projectsState.tasksUnsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'tasks'), orderBy('createdAt', 'asc')),
    function(snap) {
      projectsState.detailTasks = [];
      snap.forEach(function(d) {
        var data = d.data();
        data.id = d.id;
        projectsState.detailTasks.push(data);
      });
      refreshProjectDetailView();
    },
    function(err) {
      logError('Project tasks error', err);
    }
  );

  if (projectsState.activityUnsubscribe) {
    projectsState.activityUnsubscribe();
    projectsState.activityUnsubscribe = null;
  }
  projectsState.detailActivity = [];

  projectsState.activityUnsubscribe = onSnapshot(
    query(collection(db, 'projects', projectId, 'activity'), orderBy('createdAt', 'desc'), limit(30)),
    function(snap) {
      projectsState.detailActivity = [];
      snap.forEach(function(d) {
        var data = d.data();
        data.id = d.id;
        projectsState.detailActivity.push(data);
      });
      refreshProjectDetailView();
    },
    function(err) {
      logError('Project activity error', err);
    }
  );
};

// ─── Projects: detail view ──────────────────────────────────────────────────
var renderRecoveryCard = function(detailEl, opts) {
  if (!detailEl) return;

  opts = opts || {};
  opts.idSuffix = opts.idSuffix || '';
  var recoveryBackId = 'recoveryBackBtn' + opts.idSuffix;
  var recoveryRelinkBtnId = 'recoveryRelinkBtn' + opts.idSuffix;
  var recoveryRelinkFormId = 'recoveryRelinkForm' + opts.idSuffix;
  var recoveryRelinkInputId = 'recoveryRelinkInput' + opts.idSuffix;
  var recoveryRelinkGoId = 'recoveryRelinkGo' + opts.idSuffix;
  var recoveryRelinkCancelId = 'recoveryRelinkCancel' + opts.idSuffix;

  detailEl.innerHTML =
    '<div class="recovery-card">' +
      '<div class="recovery-card-header">' +
        '<svg class="recovery-card-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
          '<line x1="12" y1="9" x2="12" y2="13"></line>' +
          '<line x1="12" y1="17" x2="12.01" y2="17"></line>' +
        '</svg>' +
        '<div>' +
          '<h3 class="recovery-card-title">' + escapeHTML(opts.title || 'Could not load this project') + '</h3>' +
          '<p class="recovery-card-message">' + escapeHTML(opts.message || '') + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="recovery-card-tip">' +
        '<strong>To reconnect:</strong> Open the Strategy app and use ' +
        '<strong>Create Collaboration Space</strong> or <strong>Relink Existing</strong> to re-establish the bridge.' +
      '</div>' +
      '<div class="recovery-card-actions">' +
        '<a href="' + STRATEGY_APP_URL + '" target="forensicBiStrategy" class="btn btn-primary">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;">' +
            '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>' +
            '<polyline points="15 3 21 3 21 9"></polyline>' +
            '<line x1="10" y1="14" x2="21" y2="3"></line>' +
          '</svg>' +
          'Open Strategy' +
        '</a>' +
        '<button id="' + recoveryBackId + '" class="btn btn-ghost">Browse Projects</button>' +
        '<button id="' + recoveryRelinkBtnId + '" class="btn btn-ghost">Try another ID</button>' +
      '</div>' +
      '<div id="' + recoveryRelinkFormId + '" class="recovery-relink-form" hidden>' +
        '<p class="text-muted recovery-relink-hint">Paste a project ID to load it directly:</p>' +
        '<div class="recovery-relink-row">' +
          '<input id="' + recoveryRelinkInputId + '" type="text" class="edit-input" placeholder="Project ID (e.g. abc123…)" />' +
          '<button id="' + recoveryRelinkGoId + '" class="btn btn-primary">Go</button>' +
          '<button id="' + recoveryRelinkCancelId + '" class="btn btn-ghost">Cancel</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  var recoveryBack = document.getElementById(recoveryBackId);
  if (recoveryBack) recoveryBack.onclick = function() {
    projectsState.activeProjectId = null;
    resetProjectDetailState();
    var listEl2 = document.getElementById('projectsList');
    var headerEl2 = document.querySelector('.page-header-row');
    if (listEl2) listEl2.hidden = false;
    if (headerEl2) headerEl2.hidden = false;
    detailEl.hidden = true;
    detailEl.innerHTML = '';
    syncURLState();
    subscribeProjectsList();
  };

  var recoveryRelinkBtn = document.getElementById(recoveryRelinkBtnId);
  if (recoveryRelinkBtn) recoveryRelinkBtn.onclick = function() {
    var form = document.getElementById(recoveryRelinkFormId);
    if (!form) return;
    form.hidden = !form.hidden;
    var inp = document.getElementById(recoveryRelinkInputId);
    if (inp && !form.hidden) inp.focus();
  };

  var recoveryRelinkGo = document.getElementById(recoveryRelinkGoId);
  if (recoveryRelinkGo) recoveryRelinkGo.onclick = function() {
    var inp = document.getElementById(recoveryRelinkInputId);
    if (inp && inp.value.trim()) {
      var newId = inp.value.trim();
      projectsState.activeProjectId = newId;
      syncURLState();
      loadProjectDetail(newId);
    }
  };

  var recoveryRelinkCancel = document.getElementById(recoveryRelinkCancelId);
  if (recoveryRelinkCancel) recoveryRelinkCancel.onclick = function() {
    var form = document.getElementById(recoveryRelinkFormId);
    if (form) form.hidden = true;
  };

  var recoveryRelinkInput = document.getElementById(recoveryRelinkInputId);
  if (recoveryRelinkInput) recoveryRelinkInput.onkeydown = function(e) {
    if (e.key === 'Enter') {
      var go = document.getElementById(recoveryRelinkGoId);
      if (go) go.click();
    }
  };
};

var loadProjectDetail = function(projectId) {
  var listEl = document.getElementById('projectsList');
  var headerEl = document.querySelector('.page-header-row');
  var detailEl = document.getElementById('projectDetail');
  if (listEl) listEl.hidden = true;
  if (headerEl) headerEl.hidden = true;
  if (detailEl) {
    detailEl.hidden = false;
    detailEl.innerHTML = '<div class="skeleton-card" aria-hidden="true">' +
      '<div class="skeleton skeleton-line" style="width:50%;height:18px;margin-bottom:12px"></div>' +
      '<div class="skeleton skeleton-line" style="width:100%"></div>' +
      '<div class="skeleton skeleton-line" style="width:80%;margin-top:8px"></div>' +
      '<div class="skeleton skeleton-line" style="width:60%;margin-top:8px"></div>' +
      '</div>';
  }

  resetProjectDetailState();
  subscribeProjectCollections(projectId);

  projectsState.detailUnsubscribe = onSnapshot(doc(db, 'projects', projectId), function(snap) {
    if (!snap.exists()) {
      renderRecoveryCard(detailEl, {
        title: 'Collaboration space not found',
        message: 'This project was deleted or the link from your Strategy app is out of date.',
        idSuffix: ''
      });
      return;
    }
    var p = snap.data();
    p.id = snap.id;
    projectsState.detailProject = p;
    refreshProjectDetailView();
  }, function(err) {
    logError('Project detail error', err);
    renderRecoveryCard(detailEl, {
      title: 'Could not load this project',
      message: 'A connection error occurred. The project may have been deleted or you may have lost access.',
      idSuffix: '2'
    });
  });
};

var renderProjectDetail = function(p) {
  var detailEl = document.getElementById('projectDetail');
  if (!detailEl) return;

  var statusClass = 'project-status project-status-' + (p.status || 'active').replace(/\s/g, '-');
  var canEdit = state.user && (state.isAdmin || p.createdBy === state.user.uid);
  var canDelete = canEdit;

  // Members
  var memberNames = p.memberNames || {};
  var memberIds = Array.isArray(p.memberIds) ? p.memberIds : [];
  var membersHtml = memberIds.map(function(uid) {
    var name = memberNames[uid] || 'Member';
    var initials = getInitials(name);
    return '<div class="project-member-chip">' +
      '<div class="project-member-avatar">' + escapeHTML(initials) + '</div>' +
      '<span>' + escapeHTML(name) + '</span>' +
    '</div>';
  }).join('');

  // Tasks
  var allTasks = getProjectTasksForRender(p);
  var openTasks = allTasks.filter(function(t) { return t.status !== 'done'; });
  var doneTasks = allTasks.filter(function(t) { return t.status === 'done'; });
  var totalTasks = allTasks.length;
  var doneCount = doneTasks.length;
  var progressPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

  // Apply task filter
  var now = new Date();
  now.setHours(0, 0, 0, 0);
  var filteredTasks = allTasks;
  var tf = projectsState.taskFilter || 'all';
  if (tf === 'mine') {
    filteredTasks = allTasks.filter(function(t) { return state.user && t.assigneeId === state.user.uid; });
  } else if (tf === 'overdue') {
    filteredTasks = allTasks.filter(function(t) {
      if (t.status === 'done' || !t.dueDate) return false;
      return new Date(t.dueDate + 'T00:00:00') < now;
    });
  }
  var filteredOpen = filteredTasks.filter(function(t) { return t.status !== 'done'; });
  var filteredDone = filteredTasks.filter(function(t) { return t.status === 'done'; });
  var sortedTasks = filteredOpen.concat(filteredDone);

  // Overdue count for filter badge
  var overdueCount = allTasks.filter(function(t) {
    if (t.status === 'done' || !t.dueDate) return false;
    return new Date(t.dueDate + 'T00:00:00') < now;
  }).length;
  var myTaskCount = allTasks.filter(function(t) { return state.user && t.assigneeId === state.user.uid; }).length;

  // Progress bar
  var progressHtml = totalTasks > 0
    ? '<div class="task-progress">' +
        '<div class="task-progress-bar"><div class="task-progress-fill" style="width:' + progressPct + '%"></div></div>' +
        '<span class="task-progress-label">' + doneCount + '/' + totalTasks + ' done (' + progressPct + '%)</span>' +
      '</div>'
    : '';

  // Filter pills
  var filterHtml = totalTasks > 0
    ? '<div class="task-filters">' +
        '<button class="task-filter-pill' + (tf === 'all' ? ' active' : '') + '" data-task-filter="all">All (' + totalTasks + ')</button>' +
        '<button class="task-filter-pill' + (tf === 'mine' ? ' active' : '') + '" data-task-filter="mine">My Tasks (' + myTaskCount + ')</button>' +
        '<button class="task-filter-pill' + (tf === 'overdue' ? ' active' : '') + '" data-task-filter="overdue">Overdue' + (overdueCount > 0 ? ' (' + overdueCount + ')' : '') + '</button>' +
      '</div>'
    : '';

  var tasksHtml = sortedTasks.length === 0
    ? (totalTasks === 0
        ? '<div class="empty-state"><div class="empty-state-title">No tasks yet</div><p class="empty-state-text">Add one to get started.</p></div>'
        : '<div class="empty-state"><div class="empty-state-title">No tasks match this filter</div><p class="empty-state-text">Try a different filter.</p></div>')
    : sortedTasks.map(function(t) {
        var assigneeName = t.assigneeName || 'Unassigned';
        var statusCls = 'task-status task-status-' + (t.status || 'todo');
        var statusLabel = t.status === 'doing' ? 'Doing' : t.status === 'done' ? 'Done' : 'To Do';
        var dueDateHtml = '';
        if (t.dueDate) {
          var now = new Date();
          now.setHours(0, 0, 0, 0);
          var due = new Date(t.dueDate + 'T00:00:00');
          var diffDays = Math.round((due - now) / 86400000);
          var dueCls = 'task-due';
          if (t.status !== 'done') {
            if (diffDays < 0) dueCls += ' task-overdue';
            else if (diffDays === 0) dueCls += ' task-due-today';
          }
          dueDateHtml = '<span class="' + dueCls + '">' + escapeHTML(t.dueDate) + '</span>';
        }
        var isDone = t.status === 'done';
        var canEditTask = state.isAdmin || (state.user && t.createdBy === state.user.uid);
        return '<div class="task-row' + (isDone ? ' task-done' : '') + '" data-task-id="' + escapeAttr(t.id) + '">' +
          '<button class="task-status-btn ' + statusCls + '" data-task-cycle="' + escapeAttr(t.id) + '" title="Cycle status">' + statusLabel + '</button>' +
          '<div class="task-info">' +
            '<span class="task-title">' + escapeHTML(t.title || 'Untitled') + '</span>' +
            '<span class="task-assignee">' + escapeHTML(assigneeName) + '</span>' +
          '</div>' +
          dueDateHtml +
          (canEditTask ? '<button class="task-edit-btn" data-task-edit="' + escapeAttr(t.id) + '" title="Edit task" aria-label="Edit task">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
            '</button>' : '') +
          (canEditTask ? '<button class="task-delete-btn" data-task-delete="' + escapeAttr(t.id) + '" title="Delete task" aria-label="Delete task">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
            '</button>' : '') +
        '</div>';
      }).join('');

  // Files
  var files = getProjectFilesForRender(p);
  var filesHtml = files.length === 0
    ? '<div class="empty-state"><div class="empty-state-title">No files yet</div><p class="empty-state-text">Attach files from Drive to share with the team.</p></div>'
    : files.map(function(f) {
        return '<div class="project-file-row">' +
          (f.iconUrl
            ? '<img src="' + escapeAttr(f.iconUrl) + '" width="18" height="18" alt="" />'
            : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-muted);flex-shrink:0;">' +
                '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>' +
                '<polyline points="14 2 14 8 20 8"></polyline>' +
              '</svg>') +
          '<a href="' + escapeAttr(f.fileUrl) + '" target="_blank" rel="noopener">' + escapeHTML(f.fileName || 'File') + '</a>' +
          '<span class="project-file-meta">by ' + escapeHTML(f.addedByName || 'Member') + '</span>' +
        '</div>';
      }).join('');

  // Comments / discussion
  var comments = getProjectCommentsForRender(p);
  var commentsHtml = comments.length === 0
    ? '<div class="empty-state"><div class="empty-state-title">No discussion yet</div><p class="empty-state-text">Start the conversation below.</p></div>'
    : comments.map(function(c) {
    var cTime = (c.createdAt && typeof c.createdAt.toDate === 'function')
      ? relativeTime(c.createdAt.toDate())
      : 'just now';
    return '<div class="project-comment">' +
      '<div class="project-comment-avatar">' + escapeHTML(getInitials(c.authorName || '?')) + '</div>' +
      '<div class="project-comment-body">' +
        '<span class="project-comment-author">' + escapeHTML(c.authorName || 'Member') + '</span>' +
        '<span class="project-comment-time">' + escapeHTML(cTime) + '</span>' +
        '<div class="project-comment-text">' + highlightMentions(linkifyText(escapeHTML(c.body || ''))) + '</div>' +
      '</div>' +
    '</div>';
    }).join('');

  var pendingList = Array.isArray(p.pendingInvites) ? p.pendingInvites : [];
  var canManageInvites = state.user && (state.isAdmin || p.createdBy === state.user.uid);
  var pendingSectionHtml = (pendingList.length > 0 && canManageInvites)
    ? '<div class="project-detail-section">' +
        '<h3>Pending Invitations <span class="task-count">' + pendingList.length + '</span></h3>' +
        '<div class="project-members-list">' +
          pendingList.map(function(email) {
            return '<span class="project-member-chip" style="font-family:var(--mono);font-size:12px;">' +
              escapeHTML(email) +
              ' <button class="pending-invite-chip-remove" data-revoke-invite="' + escapeAttr(email) + '" aria-label="Revoke">\xd7</button>' +
            '</span>';
          }).join('') +
        '</div>' +
      '</div>'
    : '';

  detailEl.innerHTML = '' +
    '<div class="project-detail-header">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">' +
        '<button class="project-detail-back" id="projectBackBtn">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<line x1="19" y1="12" x2="5" y2="12"></line>' +
            '<polyline points="12 19 5 12 12 5"></polyline>' +
          '</svg>' +
          '<span>Back to Projects</span>' +
        '</button>' +
        (p.originApp === 'roadmap' ?
          '<a href="' + STRATEGY_APP_URL + '" target="forensicBiStrategy" ' +
             'style="display:inline-flex;align-items:center;gap:4px;background:#C8A96E18;border:1px solid #C8A96E40;' +
                    'color:#C8A96E;border-radius:20px;padding:3px 12px;text-decoration:none;font-size:11px;font-weight:600;">' +
            'Open Strategy' +
          '</a>'
        : '') +
      '</div>' +
      '<div class="project-detail-title">' + escapeHTML(p.name || 'Untitled') + '</div>' +
      '<span class="' + statusClass + '">' + escapeHTML(statusLabel(p.status)) + '</span>' +
      '<button type="button" class="project-id-chip" id="projectIdChip" title="Click to copy project ID">' +
        '<span class="project-id-chip-text">ID: ' + escapeHTML(p.id) + '</span>' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
          '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
        '</svg>' +
      '</button>' +
      (p.description ? '<div class="project-detail-desc">' + escapeHTML(p.description) + '</div>' : '') +
      (canEdit ? '<div class="project-detail-actions">' +
        '<button class="btn btn-ghost" id="projectEditBtn">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
          'Edit / Members' +
        '</button>' +
        (canDelete ? '<button class="btn btn-ghost post-action-danger" id="projectDeleteBtn">Delete</button>' : '') +
      '</div>' : '') +
    '</div>' +

    '<div class="project-detail-section">' +
      '<h3>Tasks <span class="task-count">' + openTasks.length + ' open</span></h3>' +
      progressHtml +
      filterHtml +
      '<div class="project-tasks-list">' + tasksHtml + '</div>' +
      '<form class="task-add-form" id="taskAddForm">' +
        '<input type="text" class="form-input" id="taskTitleInput" placeholder="Task title..." maxlength="200" />' +
        '<select class="form-input task-add-assignee" id="taskAssigneeInput" aria-label="Assignee">' +
          '<option value="">Unassigned</option>' +
          memberIds.map(function(uid) {
            return '<option value="' + escapeAttr(uid) + '">' + escapeHTML(memberNames[uid] || 'Member') + '</option>';
          }).join('') +
        '</select>' +
        '<input type="date" class="form-input task-add-date" id="taskDueDateInput" />' +
        '<button class="btn btn-primary" type="submit">Add</button>' +
      '</form>' +
    '</div>' +

    '<div class="project-detail-section">' +
      '<h3>Members' + (canEdit ? ' <button class="btn btn-ghost project-manage-btn" id="projectManageMembersBtn">+ Manage</button>' : '') + '</h3>' +
      '<div class="project-members-list">' + membersHtml + '</div>' +
    '</div>' +

    pendingSectionHtml +

    '<div class="project-detail-section">' +
      '<h3>Files</h3>' +
      '<div class="project-files-list">' + filesHtml + '</div>' +
      '<button class="btn btn-ghost project-attach-btn" id="projectAttachFileBtn">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px;"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>' +
        'Attach from Drive' +
      '</button>' +
    '</div>' +

    '<div class="project-detail-section project-activity-section">' +
      '<h3>Activity</h3>' +
      '<div class="project-activity-log">' +
        (projectsState.detailActivity.length === 0
          ? '<div class="empty-state"><div class="empty-state-title">No activity yet</div><p class="empty-state-text">Project actions will show up here as they happen.</p></div>'
          : projectsState.detailActivity.map(function(a) {
              var aTime = (a.createdAt && typeof a.createdAt.toDate === 'function')
                ? relativeTime(a.createdAt.toDate())
                : 'just now';
              var activityIconSvg;
              if (a.action === 'status') {
                activityIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
              } else if (a.action === 'created') {
                activityIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
              } else {
                activityIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
              }
              return '<div class="activity-entry">' +
                '<span class="activity-icon">' + activityIconSvg + '</span>' +
                '<span class="activity-text"><strong>' + escapeHTML(a.authorName || 'Member') + '</strong> ' + escapeHTML(a.detail || a.action || '') + '</span>' +
                '<span class="activity-time">' + escapeHTML(aTime) + '</span>' +
              '</div>';
            }).join('')) +
      '</div>' +
    '</div>' +

    '<div class="project-detail-section">' +
      '<h3>Discussion</h3>' +
      '<div class="project-discussion">' + commentsHtml + '</div>' +
      '<form class="project-comment-compose" id="projectCommentForm">' +
        '<input type="text" maxlength="500" placeholder="Write a comment..." id="projectCommentInput" />' +
        '<button class="btn btn-primary" type="submit">Send</button>' +
      '</form>' +
    '</div>';

  // Wire project ID copy chip
  var idChip = document.getElementById('projectIdChip');
  if (idChip) idChip.onclick = function() {
    navigator.clipboard.writeText(p.id).then(function() {
      var textSpan = idChip.querySelector('.project-id-chip-text');
      if (!textSpan) return;
      var originalText = textSpan.textContent;
      textSpan.textContent = 'Copied!';
      setTimeout(function() {
        textSpan.textContent = originalText;
      }, 1500);
    });
  };

  // Wire back button
  var backBtn = document.getElementById('projectBackBtn');
  if (backBtn) backBtn.onclick = function() {
    projectsState.activeProjectId = null;
    resetProjectDetailState();
    var listEl = document.getElementById('projectsList');
    var headerEl = document.querySelector('.page-header-row');
    var detailEl2 = document.getElementById('projectDetail');
    if (listEl) listEl.hidden = false;
    if (headerEl) headerEl.hidden = false;
    if (detailEl2) { detailEl2.hidden = true; detailEl2.innerHTML = ''; }
    syncURLState();
    if (projectsState.unsubscribe) {
      projectsState.unsubscribe();
      projectsState.unsubscribe = null;
    }
    subscribeProjectsList();
  };

  // Wire edit
  var editBtn = document.getElementById('projectEditBtn');
  if (editBtn) editBtn.onclick = function() {
    projectsState.editingProjectId = p.id;
    openProjectModal(p);
  };

  // Wire manage members shortcut (same modal, members section already scrollable)
  var manageMembersBtn = document.getElementById('projectManageMembersBtn');
  if (manageMembersBtn) manageMembersBtn.onclick = function() {
    projectsState.editingProjectId = p.id;
    openProjectModal(p);
  };

  // Wire invite revoke buttons
  document.querySelectorAll('[data-revoke-invite]').forEach(function(btn) {
    btn.onclick = function() {
      var email = btn.dataset.revokeInvite;
      showConfirmModal('Revoke invitation', 'Revoke the invitation for ' + email + '?', 'Revoke').then(function(ok) {
        if (!ok) return;
        var newPending = (p.pendingInvites || []).filter(function(e) { return e !== email; });
        updateDoc(doc(db, 'projects', p.id), {
          pendingInvites: newPending,
          updatedAt: serverTimestamp()
        }).then(function() {
          showToast('Invitation revoked.', 'info');
        }).catch(function(err) {
          logError('Revoke invite error', err);
          showToast('Failed to revoke.', 'error');
        });
      });
    };
  });

  // Wire delete
  var deleteBtn = document.getElementById('projectDeleteBtn');
  if (deleteBtn) deleteBtn.onclick = function() {
    showConfirmModal('Delete project', 'Delete this project? This cannot be undone.', 'Delete').then(function(ok) {
      if (!ok) return;
      // Clean up subcollections before deleting project doc
      var projectRef = doc(db, 'projects', p.id);
      var commentsCol = collection(db, 'projects', p.id, 'comments');
      var filesCol = collection(db, 'projects', p.id, 'files');
      var tasksCol = collection(db, 'projects', p.id, 'tasks');
      var activityCol = collection(db, 'projects', p.id, 'activity');
      Promise.all([getDocs(commentsCol), getDocs(filesCol), getDocs(tasksCol), getDocs(activityCol)]).then(function(results) {
        var deletes = [];
        results.forEach(function(snap) {
          snap.forEach(function(d) { deletes.push(deleteDoc(d.ref)); });
        });
        return Promise.all(deletes);
      }).then(function() {
        return deleteDoc(projectRef);
      }).then(function() {
        showToast('Project deleted.', 'info');
        projectsState.activeProjectId = null;
        loadPage('projects');
      }).catch(function(err) {
        logError('Delete project error', err);
        showToast('Failed to delete project.', 'error');
      });
    });
  };

  // Wire file attach
  var attachBtn = document.getElementById('projectAttachFileBtn');
  if (attachBtn) attachBtn.onclick = function() {
    pickerState.context = 'project';
    pickerState.projectId = p.id;
    openDrivePicker();
  };

  // Wire comment form
  var commentForm = document.getElementById('projectCommentForm');
  if (commentForm) commentForm.onsubmit = function(e) {
    e.preventDefault();
    var input = document.getElementById('projectCommentInput');
    var body = (input ? input.value : '').trim();
    if (!body) return;
    handleProjectComment(p.id, body);
    if (input) input.value = '';
  };

  // Wire @mention autocomplete on comment input
  var commentInput = document.getElementById('projectCommentInput');
  if (commentInput) {
    var mentionDropdown = null;
    commentInput.addEventListener('input', function() {
      var val = commentInput.value;
      var cursorPos = commentInput.selectionStart;
      var textBeforeCursor = val.substring(0, cursorPos);
      var atMatch = textBeforeCursor.match(/@(\w*)$/);

      if (mentionDropdown) { mentionDropdown.remove(); mentionDropdown = null; }

      if (!atMatch) return;
      var search = atMatch[1].toLowerCase();
      var matches = memberIds.filter(function(uid) {
        var name = (memberNames[uid] || '').toLowerCase();
        return name.indexOf(search) !== -1;
      });
      if (matches.length === 0) return;

      mentionDropdown = document.createElement('div');
      mentionDropdown.className = 'mention-dropdown';
      matches.forEach(function(uid) {
        var option = document.createElement('div');
        option.className = 'mention-option';
        option.textContent = memberNames[uid] || 'Member';
        option.onclick = function() {
          var before = val.substring(0, cursorPos - atMatch[0].length);
          var after = val.substring(cursorPos);
          var name = memberNames[uid] || 'Member';
          commentInput.value = before + '@' + name + ' ' + after;
          commentInput.focus();
          var newPos = before.length + name.length + 2;
          commentInput.setSelectionRange(newPos, newPos);
          if (mentionDropdown) { mentionDropdown.remove(); mentionDropdown = null; }
        };
        mentionDropdown.appendChild(option);
      });
      commentForm.style.position = 'relative';
      commentForm.appendChild(mentionDropdown);
    });

    commentInput.addEventListener('blur', function() {
      setTimeout(function() {
        if (mentionDropdown) { mentionDropdown.remove(); mentionDropdown = null; }
      }, 200);
    });
  }

  // Wire task add form
  var taskForm = document.getElementById('taskAddForm');
  if (taskForm) taskForm.onsubmit = function(e) {
    e.preventDefault();
    var titleInput = document.getElementById('taskTitleInput');
    var assigneeInput = document.getElementById('taskAssigneeInput');
    var dueDateInput = document.getElementById('taskDueDateInput');
    var title = (titleInput ? titleInput.value : '').trim();
    if (!title) return;
    var assigneeId = assigneeInput ? assigneeInput.value : '';
    var assigneeName = '';
    if (assigneeId && assigneeInput) {
      var sel = assigneeInput.options[assigneeInput.selectedIndex];
      assigneeName = sel ? sel.textContent : '';
    }
    handleAddTask(p.id, {
      title: title,
      assigneeId: assigneeId,
      assigneeName: assigneeName,
      dueDate: dueDateInput ? dueDateInput.value : ''
    });
    if (titleInput) titleInput.value = '';
    if (assigneeInput) assigneeInput.value = '';
    if (dueDateInput) dueDateInput.value = '';
  };

  // Wire task status cycling
  document.querySelectorAll('[data-task-cycle]').forEach(function(btn) {
    btn.onclick = function() {
      var taskId = btn.dataset.taskCycle;
      var task = projectsState.detailTasks.find(function(t) { return t.id === taskId; });
      if (!task) return;
      var nextStatus = task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : 'todo';
      updateDoc(doc(db, 'projects', p.id, 'tasks', taskId), {
        status: nextStatus
      }).then(function() {
        var statusLabels = { todo: 'To Do', doing: 'Doing', done: 'Done' };
        logProjectActivity(p.id, 'status', 'moved "' + (task.title || 'Untitled') + '" to ' + statusLabels[nextStatus]);
        // Notify assignee about status change
        if (task.assigneeId && task.assigneeId !== state.user.uid) {
          var actor = state.user.displayName || state.user.email || 'Member';
          writeNotification(task.assigneeId, 'task-status', actor + ' moved "' + (task.title || 'Untitled') + '" to ' + statusLabels[nextStatus], { page: 'projects', params: { projectId: p.id } });
        }
        // Recompute taskDone
        var doneCount = projectsState.detailTasks.filter(function(t) {
          return t.id === taskId ? nextStatus === 'done' : t.status === 'done';
        }).length;
        updateDoc(doc(db, 'projects', p.id), {
          taskDone: doneCount,
          updatedAt: serverTimestamp()
        });
      }).catch(function(err) {
        logError('Task status update error', err);
        showToast('Failed to update task.', 'error');
      });
    };
  });

  // Wire task delete
  document.querySelectorAll('[data-task-delete]').forEach(function(btn) {
    btn.onclick = function() {
      var taskId = btn.dataset.taskDelete;
      showConfirmModal('Delete task', 'Delete this task?', 'Delete').then(function(ok) {
        if (!ok) return;
        var taskToDelete = projectsState.detailTasks.find(function(t) { return t.id === taskId; });
        deleteDoc(doc(db, 'projects', p.id, 'tasks', taskId)).then(function() {
          var newTotal = Math.max(0, (projectsState.detailProject && projectsState.detailProject.taskTotal || 0) - 1);
          var newDone = Math.max(0, (projectsState.detailProject && projectsState.detailProject.taskDone || 0) - (taskToDelete && taskToDelete.status === 'done' ? 1 : 0));
          updateDoc(doc(db, 'projects', p.id), {
            taskTotal: newTotal,
            taskDone: newDone,
            updatedAt: serverTimestamp()
          });
        }).catch(function(err) {
          logError('Delete task error', err);
          showToast('Failed to delete task.', 'error');
        });
      });
    };
  });

  // Wire task inline edit
  document.querySelectorAll('[data-task-edit]').forEach(function(btn) {
    btn.onclick = function() {
      var taskId = btn.dataset.taskEdit;
      var task = projectsState.detailTasks.find(function(t) { return t.id === taskId; });
      if (!task) return;
      var row = document.querySelector('[data-task-id="' + taskId + '"]');
      if (!row || row.querySelector('.task-edit-form')) return;

      var assigneeOptions = '<option value="">Unassigned</option>' +
        memberIds.map(function(uid) {
          var sel = uid === task.assigneeId ? ' selected' : '';
          return '<option value="' + escapeAttr(uid) + '"' + sel + '>' + escapeHTML(memberNames[uid] || 'Member') + '</option>';
        }).join('');

      row.innerHTML = '' +
        '<form class="task-edit-form" data-task-save="' + escapeAttr(taskId) + '">' +
          '<input type="text" class="form-input" value="' + escapeAttr(task.title || '') + '" data-edit-title maxlength="200" />' +
          '<select class="form-input task-add-assignee" data-edit-assignee aria-label="Assignee">' + assigneeOptions + '</select>' +
          '<input type="date" class="form-input task-add-date" value="' + escapeAttr(task.dueDate || '') + '" data-edit-due />' +
          '<button class="btn btn-primary" type="submit">Save</button>' +
          '<button class="btn btn-ghost" type="button" data-edit-cancel>Cancel</button>' +
        '</form>';

      var form = row.querySelector('form');
      form.querySelector('[data-edit-title]').focus();

      form.onsubmit = function(e) {
        e.preventDefault();
        var newTitle = form.querySelector('[data-edit-title]').value.trim();
        if (!newTitle) return;
        var assigneeSelect = form.querySelector('[data-edit-assignee]');
        var newAssigneeId = assigneeSelect.value;
        var newAssigneeName = '';
        if (newAssigneeId) {
          var opt = assigneeSelect.options[assigneeSelect.selectedIndex];
          newAssigneeName = opt ? opt.textContent : '';
        }
        var newDueDate = form.querySelector('[data-edit-due]').value;
        updateDoc(doc(db, 'projects', p.id, 'tasks', taskId), {
          title: newTitle,
          assigneeId: newAssigneeId,
          assigneeName: newAssigneeName,
          dueDate: newDueDate,
          status: task.status
        }).then(function() {
          showToast('Task updated.', 'info');
          var changes = [];
          if (newTitle !== task.title) changes.push('renamed to "' + newTitle + '"');
          if (newAssigneeId !== task.assigneeId) changes.push('reassigned to ' + (newAssigneeName || 'Unassigned'));
          if (newDueDate !== (task.dueDate || '')) changes.push('due date set to ' + (newDueDate || 'none'));
          if (changes.length > 0) {
            logProjectActivity(p.id, 'edited', '"' + (task.title || 'Untitled') + '": ' + changes.join(', '));
          }
          // Notify new assignee on reassignment
          if (newAssigneeId && newAssigneeId !== task.assigneeId && newAssigneeId !== state.user.uid) {
            var projName = p.name || 'a project';
            var actor = state.user.displayName || state.user.email || 'Member';
            writeNotification(newAssigneeId, 'task-assigned', actor + ' assigned you "' + newTitle + '" in ' + projName, { page: 'projects', params: { projectId: p.id } });
          }
          // Recompute taskDone (status is preserved in inline edit)
          var doneCount = projectsState.detailTasks.filter(function(t) {
            return t.status === 'done';
          }).length;
          updateDoc(doc(db, 'projects', p.id), {
            taskDone: doneCount,
            updatedAt: serverTimestamp()
          });
          if (projectsState.detailProject) {
            renderProjectDetail(projectsState.detailProject);
          }
        }).catch(function(err) {
          logError('Task edit error', err);
          showToast('Failed to update task.', 'error');
        });
      };

      form.querySelector('[data-edit-cancel]').onclick = function() {
        refreshProjectDetailView();
      };
    };
  });

  // Wire task filter pills
  document.querySelectorAll('[data-task-filter]').forEach(function(pill) {
    pill.onclick = function() {
      projectsState.taskFilter = pill.dataset.taskFilter;
      if (projectsState.detailProject) {
        renderProjectDetail(projectsState.detailProject);
      }
    };
  });

  syncSidebarSelection();
};

// ─── Projects: modal ────────────────────────────────────────────────────────
var openProjectModal = function(existingProject) {
  var modal = document.getElementById('projectModal');
  if (!modal) return;

  var titleEl = document.getElementById('projectModalTitle');
  var nameInput = document.getElementById('projectNameInput');
  var descInput = document.getElementById('projectDescInput');
  var statusInput = document.getElementById('projectStatusInput');

  if (titleEl) titleEl.textContent = existingProject ? 'Edit Project' : 'New Project';
  if (nameInput) nameInput.value = existingProject ? (existingProject.name || '') : '';
  if (descInput) descInput.value = existingProject ? (existingProject.description || '') : '';
  if (statusInput) statusInput.value = existingProject ? (existingProject.status || 'active') : 'active';

  // Load member checkboxes
  loadProjectMemberChecks(existingProject);

  // Init pending-invites editor
  modalPendingInvites = (existingProject && Array.isArray(existingProject.pendingInvites))
    ? existingProject.pendingInvites.slice()
    : [];
  renderModalPendingInvitesList();

  var addInviteBtn = document.getElementById('projectPendingInviteAddBtn');
  var inviteInput = document.getElementById('projectPendingInviteInput');
  if (addInviteBtn) addInviteBtn.onclick = function() {
    if (!inviteInput) return;
    var email = (inviteInput.value || '').trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) {
      showToast('Enter a valid email address.', 'error');
      return;
    }
    if (modalPendingInvites.indexOf(email) !== -1) {
      showToast('Already in the invite list.', 'error');
      return;
    }
    modalPendingInvites.push(email);
    inviteInput.value = '';
    renderModalPendingInvitesList();
  };
  if (inviteInput) inviteInput.onkeydown = function(e) {
    if (e.key === 'Enter') { e.preventDefault(); if (addInviteBtn) addInviteBtn.click(); }
  };

  // Wire cancel button
  var cancelBtn = document.getElementById('projectModalCancel');
  if (cancelBtn) cancelBtn.onclick = closeProjectModal;

  // Wire backdrop click
  var backdrop = modal.querySelector('.project-modal-backdrop');
  if (backdrop) backdrop.onclick = closeProjectModal;

  modal.classList.add('visible');
};

var closeProjectModal = function() {
  var modal = document.getElementById('projectModal');
  if (modal) modal.classList.remove('visible');
};

var loadProjectMemberChecks = function(existingProject) {
  var container = document.getElementById('projectMemberChecks');
  if (!container) return;
  container.innerHTML = '<span class="text-muted">Loading...</span>';

  getDocs(collection(db, 'users')).then(function(snap) {
    if (snap.empty) {
      container.innerHTML = '<span class="text-muted">No members found.</span>';
      return;
    }

    var existingMembers = existingProject && Array.isArray(existingProject.memberIds)
      ? existingProject.memberIds
      : (state.user ? [state.user.uid] : []);

    var html = '';
    snap.forEach(function(d) {
      var u = d.data();
      var memberName = u.name || u.displayName || u.email || 'Member';
      var checked = existingMembers.indexOf(d.id) !== -1 ? ' checked' : '';
      var disabled = d.id === (state.user ? state.user.uid : '') ? ' disabled' : '';
      html += '<label><input type="checkbox" value="' + escapeAttr(d.id) + '" data-name="' + escapeAttr(memberName) + '"' + checked + disabled + ' /> ' + escapeHTML(memberName) + '</label>';
    });
    container.innerHTML = html;
  }).catch(function(err) {
    logError('Load members error', err);
    container.innerHTML = '<span class="text-muted">Failed to load members.</span>';
  });
};

// ─── Projects: save (create or update) ──────────────────────────────────────
var handleSaveProject = function() {
  var nameInput = document.getElementById('projectNameInput');
  var descInput = document.getElementById('projectDescInput');
  var statusInput = document.getElementById('projectStatusInput');
  var container = document.getElementById('projectMemberChecks');

  var name = (nameInput ? nameInput.value : '').trim();
  if (!name) {
    showToast('Project name is required.', 'error');
    return;
  }

  var description = (descInput ? descInput.value : '').trim();
  var status = statusInput ? statusInput.value : 'active';

  // Gather selected members
  var memberIds = [];
  var memberNames = {};
  if (container) {
    container.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb) {
      memberIds.push(cb.value);
      memberNames[cb.value] = cb.dataset.name || 'Member';
    });
  }
  // Ensure creator is always included
  if (state.user && memberIds.indexOf(state.user.uid) === -1) {
    memberIds.push(state.user.uid);
    memberNames[state.user.uid] = state.user.displayName || state.user.email || 'Member';
  }

  var saveBtn = document.getElementById('projectModalSave');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  if (projectsState.editingProjectId) {
    // Update existing
    updateDoc(doc(db, 'projects', projectsState.editingProjectId), {
      name: name,
      description: description,
      status: status,
      memberIds: memberIds,
      memberNames: memberNames,
      pendingInvites: modalPendingInvites.slice(),
      updatedAt: serverTimestamp()
    }).then(function() {
      closeProjectModal();
      showToast('Project updated.', 'info');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    }).catch(function(err) {
      logError('Update project error', err);
      showToast('Failed to update: ' + (err.message || ''), 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    });
  } else {
    // Create new
    addDoc(collection(db, 'projects'), {
      name: name,
      description: description,
      status: status,
      createdBy: state.user.uid,
      createdByName: state.user.displayName || state.user.email || 'Member',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      memberIds: memberIds,
      memberNames: memberNames,
      pendingInvites: modalPendingInvites.slice(),
      taskTotal: 0,
      taskDone: 0
    }).then(function(docRef) {
      closeProjectModal();
      showToast('Project created!', 'info');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      projectsState.activeProjectId = docRef.id;
      syncURLState();
      loadProjectDetail(docRef.id);
    }).catch(function(err) {
      logError('Create project error', err);
      showToast('Failed to create: ' + (err.message || ''), 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    });
  }
};

// ─── Projects: add comment ──────────────────────────────────────────────────
var handleProjectComment = function(projectId, body) {
  var projectName = projectsState.detailProject ? (projectsState.detailProject.name || 'a project') : 'a project';
  var actorName = state.user.displayName || state.user.email || 'Member';
  return addDoc(collection(db, 'projects', projectId, 'comments'), {
    authorId: state.user.uid,
    authorName: actorName,
    body: body,
    createdAt: serverTimestamp()
  }).then(function() {
    // Notify @mentioned users
    var bodyLower = body.toLowerCase();
    (membersState.members || []).forEach(function(m) {
      if (m.uid === state.user.uid) return;
      var name = (m.name || '').toLowerCase();
      if (!name) return;
      if (bodyLower.indexOf('@' + name) !== -1) {
        writeNotification(m.uid, 'mention', actorName + ' mentioned you in ' + projectName, { page: 'projects', params: { projectId: projectId } });
      }
    });
    // Notify project owner
    if (projectsState.detailProject && projectsState.detailProject.createdBy && projectsState.detailProject.createdBy !== state.user.uid) {
      writeNotification(projectsState.detailProject.createdBy, 'project-comment', actorName + ' commented in ' + projectName, { page: 'projects', params: { projectId: projectId } });
    }
  }).catch(function(err) {
    logError('Project comment error', err);
    showToast('Failed to post comment.', 'error');
  });
};

// ─── Projects: attach file ──────────────────────────────────────────────────
var handleProjectFileAttach = function(projectId, fileData) {
  addDoc(collection(db, 'projects', projectId, 'files'), {
    fileUrl: fileData.fileUrl || '',
    fileName: fileData.fileName || 'File',
    iconUrl: fileData.iconUrl || '',
    addedBy: state.user.uid,
    addedByName: state.user.displayName || state.user.email || 'Member',
    addedAt: serverTimestamp()
  }).then(function() {
    showToast('File attached!', 'info');
  }).catch(function(err) {
    logError('Project file attach error', err);
    showToast('Failed to attach file.', 'error');
  });
};

// ─── Projects: add task ────────────────────────────────────────────────────
var logProjectActivity = function(projectId, action, detail) {
  return addDoc(collection(db, 'projects', projectId, 'activity'), {
    action: action,
    detail: detail || '',
    authorId: state.user.uid,
    authorName: state.user.displayName || state.user.email || 'Member',
    createdAt: serverTimestamp()
  }).catch(function(err) {
    logError('Activity log error', err);
  });
};

var handleAddTask = function(projectId, taskData) {
  return addDoc(collection(db, 'projects', projectId, 'tasks'), {
    title: taskData.title,
    assigneeId: taskData.assigneeId || '',
    assigneeName: taskData.assigneeName || '',
    dueDate: taskData.dueDate || '',
    status: 'todo',
    createdBy: state.user.uid,
    createdByName: state.user.displayName || state.user.email || 'Member',
    createdAt: serverTimestamp()
  }).then(function() {
    showToast('Task added.', 'info');
    logProjectActivity(projectId, 'created', 'added task "' + taskData.title + '"');
    // Notify assignee
    if (taskData.assigneeId && taskData.assigneeId !== state.user.uid) {
      var projName = projectsState.detailProject ? (projectsState.detailProject.name || 'a project') : 'a project';
      var actor = state.user.displayName || state.user.email || 'Member';
      writeNotification(taskData.assigneeId, 'task-assigned', actor + ' assigned you "' + taskData.title + '" in ' + projName, { page: 'projects', params: { projectId: projectId } });
    }
    updateDoc(doc(db, 'projects', projectId), {
      taskTotal: (projectsState.detailProject && projectsState.detailProject.taskTotal || 0) + 1,
      updatedAt: serverTimestamp()
    });
  }).catch(function(err) {
    logError('Add task error', err);
    showToast('Failed to add task.', 'error');
  });
};

// ─── Projects: member stack helper ──────────────────────────────────────────
var renderMemberStack = function(p) {
  var memberIds = Array.isArray(p.memberIds) ? p.memberIds : [];
  var memberNames = p.memberNames || {};

  if (memberIds.length === 0) {
    return '<div class="project-card-members"><span class="text-muted" style="font-size:11px;">No members</span></div>';
  }

  var visibleIds = memberIds.slice(0, 4);
  var remaining = memberIds.length - visibleIds.length;

  var avatarsHtml = visibleIds.map(function(uid) {
    var name = memberNames[uid] || 'Member';
    var initials = getInitials(name);
    return '<div class="project-card-member-avatar" title="' + escapeAttr(name) + '">' +
      escapeHTML(initials) +
    '</div>';
  }).join('');

  var moreHtml = remaining > 0
    ? '<div class="project-card-member-more">+' + remaining + '</div>'
    : '';

  return '<div class="project-card-members">' + avatarsHtml + moreHtml + '</div>';
};

// ─── Projects: list subscription ────────────────────────────────────────────
var subscribeProjectsList = function() {
  if (projectsState.unsubscribe) {
    projectsState.unsubscribe();
    projectsState.unsubscribe = null;
  }
  if (!state.user) return;

  var q = query(
    collection(db, 'projects'),
    where('memberIds', 'array-contains', state.user.uid),
    limit(50)
  );

  projectsState.unsubscribe = onSnapshot(q, function(snap) {
    projectsState.projects = [];
    snap.forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      projectsState.projects.push(data);
    });
    sortProjectsByUpdatedAt(projectsState.projects);
    renderProjectsList();
  }, function(err) {
    logError('Projects list error', err);
    var list = document.getElementById('projectsList');
    if (list) {
      list.innerHTML = '<div class="card"><p class="text-muted">Failed to load projects.</p></div>';
    }
  });
};

// ─── Projects: render list ──────────────────────────────────────────────────
var renderProjectsList = function() {
  var list = document.getElementById('projectsList');
  if (!list) return;

  if (projectsState.projects.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No projects yet</div><p class="empty-state-text">Shared work and project updates will appear here.</p></div>';
    return;
  }

  list.innerHTML = projectsState.projects.map(function(p) {
    var statusClass = 'project-status project-status-' + (p.status || 'active').replace(/\s/g, '-');
    var desc = escapeHTML((p.description || '').substring(0, 120));
    return '' +
      '<div class="project-card" data-project-card="' + escapeAttr(p.id) + '">' +
        '<div class="project-card-name">' + escapeHTML(p.name || 'Untitled') + '</div>' +
        (desc ? '<div class="project-card-desc">' + desc + '</div>' : '') +
        '<div class="project-card-footer">' +
          '<span class="' + statusClass + '">' + escapeHTML(statusLabel(p.status)) + '</span>' +
          renderMemberStack(p) +
          '<span class="project-card-tasks" data-task-count-for="' + escapeAttr(p.id) + '"></span>' +
        '</div>' +
      '</div>';
  }).join('');

  // Render task counts from denormalized counters on the project doc
  projectsState.projects.forEach(function(p) {
    var el = document.querySelector('[data-task-count-for="' + p.id + '"]');
    if (!el) return;
    var total = typeof p.taskTotal === 'number' ? p.taskTotal : 0;
    var done = typeof p.taskDone === 'number' ? p.taskDone : 0;
    if (total > 0) {
      var pct = Math.round((done / total) * 100);
      el.innerHTML = '<span class="project-card-tasks-label">' + done + '/' + total + ' tasks</span>' +
        '<div class="project-card-progress"><div class="project-card-progress-fill" style="width:' + pct + '%"></div></div>';
    }
  });

  list.querySelectorAll('[data-project-card]').forEach(function(card) {
    card.addEventListener('click', function() {
      projectsState.activeProjectId = card.dataset.projectCard;
      syncURLState();
      loadProjectDetail(card.dataset.projectCard);
    });
  });
};

// ─── Projects: sidebar loader ───────────────────────────────────────────────
export var loadSidebarProjects = function() {
  if (projectsState.sidebarUnsubscribe) {
    projectsState.sidebarUnsubscribe();
  }
  if (!state.user) return;

  var q = query(
    collection(db, 'projects'),
    where('memberIds', 'array-contains', state.user.uid),
    limit(50)
  );

  projectsState.sidebarUnsubscribe = onSnapshot(q, function(snap) {
    var container = document.getElementById('sidebarProjectsList');
    if (!container) return;

    if (snap.empty) {
      container.innerHTML = '<span class="text-muted" style="padding:0 12px;font-size:13px;">No projects yet</span>';
      return;
    }

    var items = [];
    snap.forEach(function(d) {
      var p = d.data();
      p.id = d.id;
      items.push(p);
    });

    sortProjectsByUpdatedAt(items);

    var html = '';
    items.slice(0, 10).forEach(function(p) {
      html += '<a class="sidebar-link sidebar-sublink" data-project="' + p.id + '" href="?page=projects&projectId=' + p.id + '">' +
        escapeHTML(p.name || 'Untitled') + '</a>';
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-project]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        projectsState.activeProjectId = btn.dataset.project;
        loadPage('projects');
      });
    });

    syncSidebarSelection();
  }, function(err) {
    logError('Sidebar projects error', err);
    var container = document.getElementById('sidebarProjectsList');
    if (container) {
      container.innerHTML = '<span class="text-muted" style="padding:0 12px;font-size:13px;">Projects unavailable</span>';
    }
  });
};

// ─── Projects: pending invitations banner ───────────────────────────────────
var pendingInvitationsUnsubscribe = null;

var loadPendingInvitations = function() {
  if (pendingInvitationsUnsubscribe) {
    pendingInvitationsUnsubscribe();
    pendingInvitationsUnsubscribe = null;
  }
  if (!state.user || !state.user.email) return;

  var myEmail = state.user.email.toLowerCase();
  var q = query(
    collection(db, 'projects'),
    where('pendingInvites', 'array-contains', myEmail)
  );

  pendingInvitationsUnsubscribe = onSnapshot(q, function(snap) {
    var banner = document.getElementById('pendingInvitationsBanner');

    // Filter out session-dismissed projects
    var dismissed = [];
    try { dismissed = JSON.parse(sessionStorage.getItem('enclaveDismissedInvites') || '[]'); } catch (e) {}

    var rows = [];
    snap.forEach(function(d) {
      if (dismissed.indexOf(d.id) !== -1) return;
      var p = d.data();
      p.id = d.id;
      rows.push(p);
    });

    if (rows.length === 0) {
      if (banner) banner.remove();
      return;
    }

    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'pendingInvitationsBanner';
      banner.className = 'pending-invitations-banner';
      var listEl = document.getElementById('projectsList');
      if (listEl && listEl.parentNode) {
        listEl.parentNode.insertBefore(banner, listEl);
      } else {
        return;
      }
    }

    banner.innerHTML = '<h4>You\'ve been invited</h4>' +
      rows.map(function(p) {
        return '<div class="pending-invitation-row">' +
          '<div class="pending-invitation-info">' +
            '<div class="pending-invitation-name">' + escapeHTML(p.name || 'Untitled') + '</div>' +
            '<div class="pending-invitation-meta">Invited by ' + escapeHTML(p.createdByName || 'a member') + '</div>' +
          '</div>' +
          '<button class="btn btn-primary" data-accept-invite="' + escapeAttr(p.id) + '">Accept</button>' +
          '<button class="btn btn-ghost" data-decline-invite="' + escapeAttr(p.id) + '">Dismiss</button>' +
        '</div>';
      }).join('');

    banner.querySelectorAll('[data-accept-invite]').forEach(function(btn) {
      btn.onclick = function() { acceptProjectInvitation(btn.dataset.acceptInvite); };
    });
    banner.querySelectorAll('[data-decline-invite]').forEach(function(btn) {
      btn.onclick = function() { declineProjectInvitation(btn.dataset.declineInvite); };
    });
  }, function(err) {
    logError('Pending invitations error', err);
  });
};

var acceptProjectInvitation = function(projectId) {
  if (!state.user || !state.user.email) return;
  var myEmail = state.user.email.toLowerCase();
  var myUid = state.user.uid;
  var myName = state.user.displayName || state.user.email || 'Member';

  getDocs(query(collection(db, 'projects'), where('pendingInvites', 'array-contains', myEmail))).then(function(snap) {
    var match = null;
    snap.forEach(function(d) { if (d.id === projectId) match = d; });
    if (!match) {
      showToast('Invitation no longer available.', 'error');
      return;
    }
    var data = match.data();
    var newMemberIds = (data.memberIds || []).slice();
    if (newMemberIds.indexOf(myUid) === -1) newMemberIds.push(myUid);
    var newMemberNames = Object.assign({}, data.memberNames || {});
    newMemberNames[myUid] = myName;
    var newPending = (data.pendingInvites || []).filter(function(e) { return e !== myEmail; });

    updateDoc(doc(db, 'projects', projectId), {
      memberIds: newMemberIds,
      memberNames: newMemberNames,
      pendingInvites: newPending,
      updatedAt: serverTimestamp()
    }).then(function() {
      showToast('Joined ' + (data.name || 'project') + '.', 'info');
      if (data.createdBy && data.createdBy !== myUid) {
        writeNotification(data.createdBy, 'project-joined',
          myName + ' joined ' + (data.name || 'a project'),
          { page: 'projects', params: { projectId: projectId } });
      }
    }).catch(function(err) {
      logError('Accept invite error', err);
      showToast('Failed to accept invitation.', 'error');
    });
  }).catch(function(err) {
    logError('Accept invite lookup error', err);
    showToast('Failed to accept invitation.', 'error');
  });
};

var declineProjectInvitation = function(projectId) {
  try {
    var key = 'enclaveDismissedInvites';
    var dismissed = JSON.parse(sessionStorage.getItem(key) || '[]');
    if (dismissed.indexOf(projectId) === -1) dismissed.push(projectId);
    sessionStorage.setItem(key, JSON.stringify(dismissed));
  } catch (e) {}
  var row = document.querySelector('[data-accept-invite="' + projectId + '"]');
  if (row) {
    var parent = row.closest('.pending-invitation-row');
    if (parent) parent.remove();
  }
  // If banner is now empty, remove it
  var banner = document.getElementById('pendingInvitationsBanner');
  if (banner && !banner.querySelector('.pending-invitation-row')) {
    banner.remove();
  }
};

// ─── Projects: teardown ─────────────────────────────────────────────────────
export var teardownProjectsPage = function() {
  var keys = ['unsubscribe', 'detailUnsubscribe', 'commentsUnsubscribe', 'filesUnsubscribe', 'tasksUnsubscribe', 'activityUnsubscribe'];
  keys.forEach(function(k) {
    if (typeof projectsState[k] === 'function') {
      projectsState[k]();
    }
    projectsState[k] = null;
  });
  if (pendingInvitationsUnsubscribe) {
    pendingInvitationsUnsubscribe();
    pendingInvitationsUnsubscribe = null;
  }
};

// ─── Projects: page init ────────────────────────────────────────────────────
export var initProjectsPage = function() {
  var createBtn = document.getElementById('createProjectBtn');
  if (createBtn) {
    createBtn.onclick = function() {
      projectsState.editingProjectId = null;
      openProjectModal();
    };
  }

  var saveBtn = document.getElementById('projectModalSave');
  if (saveBtn) saveBtn.onclick = handleSaveProject;

  // Open modal if triggered from sidebar "new project" link
  if (projectsState.openModalOnLoad) {
    projectsState.openModalOnLoad = false;
    openProjectModal();
  }

  loadPendingInvitations();

  if (projectsState.activeProjectId) {
    loadProjectDetail(projectsState.activeProjectId);
    return;
  }

  subscribeProjectsList();
};
