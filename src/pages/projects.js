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
  pickerState.context = 'feed';
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
  // opts: { title: string, message: string, idSuffix: string }
  // Mounts the card HTML into detailEl and wires up all click handlers.
  // No return value.
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
    '<div class="card" style="max-width:520px;">' +
      '<div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:16px;">' +
        '<div style="font-size:28px;flex-shrink:0;line-height:1;">⚠️</div>' +
        '<div>' +
          '<h3 style="margin:0 0 5px;font-size:16px;font-weight:600;">' + opts.title + '</h3>' +
          '<p class="text-muted" style="margin:0;font-size:13px;line-height:1.6;">' +
            opts.message +
          '</p>' +
        '</div>' +
      '</div>' +
      '<div style="padding:12px 14px;border-radius:8px;background:rgba(200,169,110,0.08);border:1px solid rgba(200,169,110,0.2);margin-bottom:18px;font-size:12px;line-height:1.7;" class="text-muted">' +
        '<strong style="color:#C8A96E;">To reconnect:</strong> Open the Strategy app and use ' +
        '<strong>Create Collaboration Space</strong> or <strong>Relink Existing</strong> to re-establish the bridge.' +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">' +
        '<a href="' + STRATEGY_APP_URL + '" target="forensicBiStrategy" ' +
           'style="display:inline-block;background:#C8A96E;color:#0D0F14;border-radius:6px;padding:8px 16px;' +
                  'text-decoration:none;font-size:13px;font-weight:700;flex-shrink:0;">' +
          '↗ Open Strategy' +
        '</a>' +
        '<button id="' + recoveryBackId + '" class="btn btn-ghost" style="font-size:13px;">Browse Projects</button>' +
        '<button id="' + recoveryRelinkBtnId + '" class="btn btn-ghost" style="font-size:13px;">↻ Try another ID</button>' +
      '</div>' +
      '<div id="' + recoveryRelinkFormId + '" style="display:none;">' +
        '<p class="text-muted" style="margin:0 0 8px;font-size:12px;">Paste a project ID to load it directly:</p>' +
        '<div style="display:flex;gap:8px;">' +
          '<input id="' + recoveryRelinkInputId + '" type="text" placeholder="Project ID (e.g. abc123…)" ' +
                 'style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;' +
                        'color:var(--text);padding:8px 12px;font-size:13px;outline:none;" />' +
          '<button id="' + recoveryRelinkGoId + '" style="background:#C8A96E;border:none;color:#0D0F14;border-radius:6px;' +
                                               'padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0;">Go →</button>' +
          '<button id="' + recoveryRelinkCancelId + '" class="btn btn-ghost" style="font-size:13px;flex-shrink:0;">Cancel</button>' +
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
    if (form) {
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
      var inp = document.getElementById(recoveryRelinkInputId);
      if (inp && form.style.display !== 'none') inp.focus();
    }
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
    if (form) form.style.display = 'none';
  };

  var recoveryRelinkInput = document.getElementById(recoveryRelinkInputId);
  if (recoveryRelinkInput) recoveryRelinkInput.onkeydown = function(e) {
    if (e.key === 'Enter') { var go = document.getElementById(recoveryRelinkGoId); if (go) go.click(); }
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
    renderProjectDetail(p);
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
    ? '<p class="text-muted" style="font-size:13px;">' + (totalTasks === 0 ? 'No tasks yet. Add one to get started.' : 'No tasks match this filter.') + '</p>'
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
          (canEditTask ? '<button class="task-edit-btn" data-task-edit="' + escapeAttr(t.id) + '" title="Edit task">&#9998;</button>' : '') +
          (canEditTask ? '<button class="task-delete-btn" data-task-delete="' + escapeAttr(t.id) + '" title="Delete task">&times;</button>' : '') +
        '</div>';
      }).join('');

  // Files
  var files = getProjectFilesForRender(p);
  var filesHtml = files.length === 0
    ? '<p class="text-muted" style="font-size:13px;">No files attached yet.</p>'
    : files.map(function(f) {
        return '<div class="project-file-row">' +
          (f.iconUrl ? '<img src="' + escapeAttr(f.iconUrl) + '" width="18" height="18" alt="" />' : '&#128196;') +
          '<a href="' + escapeAttr(f.fileUrl) + '" target="_blank" rel="noopener">' + escapeHTML(f.fileName || 'File') + '</a>' +
          '<span class="project-file-meta">by ' + escapeHTML(f.addedByName || 'Member') + '</span>' +
        '</div>';
      }).join('');

  // Comments / discussion
  var comments = getProjectCommentsForRender(p);
  var commentsHtml = comments.map(function(c) {
    var cTime = (c.createdAt && typeof c.createdAt.toDate === 'function')
      ? relativeTime(c.createdAt.toDate())
      : 'just now';
    return '<div class="project-comment">' +
      '<div class="project-comment-avatar">' + escapeHTML(getInitials(c.authorName || '?')) + '</div>' +
      '<div class="project-comment-body">' +
        '<span class="project-comment-author">' + escapeHTML(c.authorName || 'Member') + '</span>' +
        '<span class="project-comment-time">' + cTime + '</span>' +
        '<div class="project-comment-text">' + highlightMentions(linkifyText(escapeHTML(c.body || ''))) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  detailEl.innerHTML = '' +
    '<div class="project-detail-header">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">' +
        '<button class="project-detail-back" id="projectBackBtn" style="margin-bottom:0;">&larr; Back to Projects</button>' +
        (p.originApp === 'roadmap' ?
          '<a href="' + STRATEGY_APP_URL + '" target="forensicBiStrategy" ' +
             'style="display:inline-flex;align-items:center;gap:4px;background:#C8A96E18;border:1px solid #C8A96E40;' +
                    'color:#C8A96E;border-radius:20px;padding:3px 12px;text-decoration:none;font-size:11px;font-weight:600;">' +
            '&#x2197; Open Strategy' +
          '</a>'
        : '') +
      '</div>' +
      '<div class="project-detail-title">' + escapeHTML(p.name || 'Untitled') + '</div>' +
      '<span class="' + statusClass + '">' + escapeHTML(p.status || 'active') + '</span>' +
      '<span style="display:inline-flex;align-items:center;gap:6px;margin-left:8px;font-size:11px;font-family:monospace;color:var(--text-muted);background:var(--surface-2,#1e2330);border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;" title="Click to copy project ID" id="projectIdChip">' +
        'ID: ' + escapeHTML(p.id) +
        ' <span style="font-size:10px;opacity:0.6;">&#x2398;</span>' +
      '</span>' +
      (p.description ? '<div class="project-detail-desc">' + escapeHTML(p.description) + '</div>' : '') +
      (canEdit ? '<div class="project-detail-actions">' +
        '<button class="btn btn-ghost" id="projectEditBtn">✏ Edit / Members</button>' +
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
        '<select class="form-input task-add-assignee" id="taskAssigneeInput">' +
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
      '<h3>Members' + (canEdit ? ' <button class="btn btn-ghost" id="projectManageMembersBtn" style="font-size:11px;padding:2px 10px;margin-left:8px;vertical-align:middle;">+ Manage</button>' : '') + '</h3>' +
      '<div class="project-members-list">' + membersHtml + '</div>' +
    '</div>' +

    '<div class="project-detail-section">' +
      '<h3>Files</h3>' +
      '<div class="project-files-list">' + filesHtml + '</div>' +
      '<button class="btn btn-ghost" id="projectAttachFileBtn" style="margin-top:8px;">&#128193; Attach from Drive</button>' +
    '</div>' +

    '<div class="project-detail-section project-activity-section">' +
      '<h3>Activity</h3>' +
      '<div class="project-activity-log">' +
        (projectsState.detailActivity.length === 0
          ? '<p class="text-muted" style="font-size:13px;">No activity yet.</p>'
          : projectsState.detailActivity.map(function(a) {
              var aTime = (a.createdAt && typeof a.createdAt.toDate === 'function')
                ? relativeTime(a.createdAt.toDate())
                : 'just now';
              var icon = a.action === 'status' ? '&#9654;' : a.action === 'created' ? '&#43;' : '&#9998;';
              return '<div class="activity-entry">' +
                '<span class="activity-icon">' + icon + '</span>' +
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
      idChip.textContent = 'Copied!';
      setTimeout(function() {
        idChip.innerHTML = 'ID: ' + p.id + ' <span style="font-size:10px;opacity:0.6;">&#x2398;</span>';
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
        deleteDoc(doc(db, 'projects', p.id, 'tasks', taskId)).catch(function(err) {
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
          '<select class="form-input task-add-assignee" data-edit-assignee>' + assigneeOptions + '</select>' +
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
      memberNames: memberNames
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
    var mentionRe = /@(\w[\w\s]{0,30}\w)/g;
    var match;
    while ((match = mentionRe.exec(body)) !== null) {
      var mentionName = match[1].toLowerCase();
      (membersState.members || []).forEach(function(m) {
        if ((m.name || '').toLowerCase() === mentionName && m.uid !== state.user.uid) {
          writeNotification(m.uid, 'mention', actorName + ' mentioned you in ' + projectName, { page: 'projects', params: { projectId: projectId } });
        }
      });
    }
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
  }).catch(function(err) {
    logError('Add task error', err);
    showToast('Failed to add task.', 'error');
  });
};

// ─── Projects: list subscription ────────────────────────────────────────────
var subscribeProjectsList = function() {
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
    list.innerHTML = '<div class="card"><p class="text-muted">No projects yet. Create one to get started.</p></div>';
    return;
  }

  list.innerHTML = projectsState.projects.map(function(p) {
    var statusClass = 'project-status project-status-' + (p.status || 'active').replace(/\s/g, '-');
    var memberCount = Array.isArray(p.memberIds) ? p.memberIds.length : 0;
    var desc = escapeHTML((p.description || '').substring(0, 120));
    return '' +
      '<div class="project-card" data-project-card="' + escapeAttr(p.id) + '">' +
        '<div class="project-card-name">' + escapeHTML(p.name || 'Untitled') + '</div>' +
        (desc ? '<div class="project-card-desc">' + desc + '</div>' : '') +
        '<div class="project-card-footer">' +
          '<span class="' + statusClass + '">' + escapeHTML(p.status || 'active') + '</span>' +
          '<span>' + memberCount + ' member' + (memberCount !== 1 ? 's' : '') + '</span>' +
          '<span class="project-card-tasks" data-task-count-for="' + escapeAttr(p.id) + '"></span>' +
        '</div>' +
      '</div>';
  }).join('');

  // Fetch task counts per project and render mini progress
  projectsState.projects.forEach(function(p) {
    getDocs(query(collection(db, 'projects', p.id, 'tasks'))).then(function(snap) {
      var total = snap.size;
      var done = 0;
      snap.forEach(function(d) { if (d.data().status === 'done') done++; });
      var el = document.querySelector('[data-task-count-for="' + p.id + '"]');
      if (el && total > 0) {
        var pct = Math.round((done / total) * 100);
        el.innerHTML = '<span class="project-card-tasks-label">' + done + '/' + total + ' tasks</span>' +
          '<div class="project-card-progress"><div class="project-card-progress-fill" style="width:' + pct + '%"></div></div>';
      }
    }).catch(function() {});
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

  if (projectsState.activeProjectId) {
    loadProjectDetail(projectsState.activeProjectId);
    return;
  }

  subscribeProjectsList();
};
