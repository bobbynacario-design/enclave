// Firebase
import {
  doc,
  getDoc,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, resourcesState, pickerState } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr } from '../util/escape.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { showConfirmModal } from '../ui/modals.js';
import { openDrivePicker, registerPickerHandler } from '../ui/drivePicker.js';

registerPickerHandler('resource', function(file) {
  const rUrlInput = document.getElementById('resourceUrl');
  const rTitleInput = document.getElementById('resourceTitle');
  if (rUrlInput) rUrlInput.value = file.url || '';
  if (rTitleInput && !rTitleInput.value.trim()) rTitleInput.value = file.name || '';
  pickerState.context = 'feed';
  return true;
});

const RESOURCE_CATEGORIES = {
  podcast: { label: 'Podcast', color: '#E87040' },
  video:   { label: 'Video',   color: '#6366F1' },
  legal:   { label: 'Legal',   color: '#F59E0B' },
  tool:    { label: 'Tool',    color: '#10B981' },
  general: { label: 'General', color: '#8B5CF6' }
};

const pendingResourceSaves = {};
let savedResourcesLoaded = false;

const isBookmarkSavePending = function() {
  return Object.keys(pendingResourceSaves).length > 0;
};

const setResourceFormOpen = function(isOpen) {
  const form = document.getElementById('resourceAddForm');
  const toggle = document.getElementById('resourceFormToggle');
  if (!form || !toggle) return;

  form.hidden = !isOpen;
  toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  toggle.textContent = isOpen ? 'Close form' : 'Share resource';

  if (isOpen) {
    const titleInput = document.getElementById('resourceTitle');
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (titleInput) window.setTimeout(function() { titleInput.focus(); }, 200);
  }
};

const loadSavedResources = function() {
  if (!state.user) return Promise.resolve();

  return getDoc(doc(db, 'users', state.user.uid)).then(function(snap) {
    const data = snap.exists() ? (snap.data() || {}) : {};
    const saved = Array.isArray(data.savedResources) ? data.savedResources : [];
    resourcesState.savedResources = saved.filter(function(id, index) {
      return typeof id === 'string' && saved.indexOf(id) === index;
    });
    savedResourcesLoaded = true;
    renderResourceList();
  }).catch(function(err) {
    savedResourcesLoaded = false;
    logError('Load saved resources error', err);
    showToast('Saved resources could not be loaded.', 'error');
  });
};

const renderResourceList = function() {
  const listEl = document.getElementById('resourceList');
  if (!listEl) return;

  let filtered = resourcesState.resources;

  // Category / saved filter
  if (resourcesState.filter === 'saved') {
    filtered = filtered.filter(function(r) {
      return resourcesState.savedResources.indexOf(r.id) !== -1;
    });
  } else if (resourcesState.filter !== 'all') {
    filtered = filtered.filter(function(r) { return r.category === resourcesState.filter; });
  }

  // Search filter
  const q = resourcesState.searchQuery.toLowerCase();
  if (q) {
    filtered = filtered.filter(function(r) {
      return (r.title || '').toLowerCase().indexOf(q) !== -1 ||
             (r.description || '').toLowerCase().indexOf(q) !== -1 ||
             (r.url || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  if (filtered.length === 0) {
    const msg = q ? 'No resources match your search.' : (resourcesState.filter === 'saved' ? 'Save useful resources and they will appear here.' : 'No resources have been shared yet.');
    const action = q || resourcesState.filter !== 'all'
      ? '<button type="button" class="btn btn-ghost" data-clear-resource-view>Clear filters</button>'
      : '<button type="button" class="btn btn-primary" data-open-resource-form>Share the first resource</button>';
    listEl.innerHTML = '<div class="empty-state resource-empty-state">' +
      '<div class="empty-state-title">' + (q ? 'No matches' : (resourcesState.filter === 'saved' ? 'No saved resources' : 'Build the library')) + '</div>' +
      '<p class="empty-state-text">' + msg + '</p>' + action +
    '</div>';
    const summary = document.getElementById('resourceResultsSummary');
    if (summary) summary.textContent = '0 resources found';
    wireResourceEmptyActions(listEl);
    return;
  }

  const summary = document.getElementById('resourceResultsSummary');
  if (summary) {
    summary.textContent = filtered.length + ' ' + (filtered.length === 1 ? 'resource' : 'resources') +
      ((q || resourcesState.filter !== 'all') ? ' found' : ' in the library');
  }

  listEl.innerHTML = filtered.map(function(r) {
    const cat = RESOURCE_CATEGORIES[r.category] || RESOURCE_CATEGORIES.general;
    const desc = r.description ? '<p class="resource-desc">' + escapeHTML(r.description) + '</p>' : '';
    const isSaved = resourcesState.savedResources.indexOf(r.id) !== -1;
    const bookmarkBtn = '<button type="button" class="resource-icon-button resource-bookmark' + (isSaved ? ' saved' : '') + '" data-bookmark="' + escapeAttr(r.id) + '" ' +
      'aria-label="' + (isSaved ? 'Remove from saved resources' : 'Save resource') + '" aria-pressed="' + (isSaved ? 'true' : 'false') + '"' +
      ((!savedResourcesLoaded || isBookmarkSavePending()) ? ' disabled' : '') + '>' + (isSaved ? '&#9733;' : '&#9734;') + '</button>';
    const deleteBtn = state.isAdmin
      ? '<button type="button" class="resource-icon-button resource-delete" data-id="' + escapeAttr(r.id) + '" aria-label="Delete resource">&#128465;</button>'
      : '';
    return '<div class="resource-card">' +
      '<div class="resource-card-top">' +
        '<span class="resource-cat-badge" style="background:' + cat.color + ';">' + cat.label + '</span>' +
        '<div class="resource-card-actions">' + bookmarkBtn + deleteBtn + '</div>' +
      '</div>' +
      '<a href="' + escapeAttr(r.url) + '" target="_blank" rel="noopener" class="resource-title">' + escapeHTML(r.title) + '</a>' +
      desc +
      '<div class="resource-meta">Added by ' + escapeHTML(r.addedByName) + (r.createdAt ? ' &middot; ' + (r.createdAt.toDate ? r.createdAt.toDate() : new Date(r.createdAt)).toLocaleDateString() : '') + '</div>' +
    '</div>';
  }).join('');

  // Wire bookmark buttons
  listEl.querySelectorAll('.resource-bookmark').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const rid = btn.getAttribute('data-bookmark');
      if (!state.user || !rid || !savedResourcesLoaded || isBookmarkSavePending()) return;
      const previous = resourcesState.savedResources.slice();
      const next = previous.slice();
      const idx = next.indexOf(rid);
      const isRemoving = idx !== -1;
      if (idx !== -1) {
        next.splice(idx, 1);
      } else {
        next.push(rid);
      }
      pendingResourceSaves[rid] = true;
      resourcesState.savedResources = next;
      renderResourceList();

      updateDoc(doc(db, 'users', state.user.uid), {
        savedResources: next
      }).then(function() {
        delete pendingResourceSaves[rid];
        renderResourceList();
        showToast(isRemoving ? 'Removed from saved resources.' : 'Saved for later.', 'success');
      }).catch(function(err) {
        logError('Save bookmark error', err);
        delete pendingResourceSaves[rid];
        resourcesState.savedResources = previous;
        renderResourceList();
        showToast('Could not update saved resources.', 'error');
      });
    });
  });

  // Wire delete buttons
  listEl.querySelectorAll('.resource-delete').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const rid = btn.getAttribute('data-id');
      showConfirmModal('Delete Resource', 'Remove this resource from the library?', 'Delete').then(function(ok) {
        if (!ok) return;
        deleteDoc(doc(db, 'resources', rid)).catch(function(err) {
          logError('Delete resource error', err);
        });
      });
    });
  });
};

const wireResourceEmptyActions = function(container) {
  const clearBtn = container.querySelector('[data-clear-resource-view]');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      resourcesState.filter = 'all';
      resourcesState.searchQuery = '';
      const searchInput = document.getElementById('resourceSearch');
      if (searchInput) searchInput.value = '';
      document.querySelectorAll('.resource-filter-pill').forEach(function(pill) {
        pill.classList.toggle('active', pill.dataset.cat === 'all');
      });
      renderResourceList();
    });
  }

  const openBtn = container.querySelector('[data-open-resource-form]');
  if (openBtn) openBtn.addEventListener('click', function() { setResourceFormOpen(true); });
};

export const initResourcesPage = function() {
  savedResourcesLoaded = false;
  const addForm = document.getElementById('resourceAddForm');
  const formToggle = document.getElementById('resourceFormToggle');
  const formCancel = document.getElementById('resourceFormCancel');
  if (formToggle && addForm && state.user) {
    formToggle.addEventListener('click', function() { setResourceFormOpen(addForm.hidden); });
  }
  if (formCancel) formCancel.addEventListener('click', function() { setResourceFormOpen(false); });

  loadSavedResources();

  // Filter pills
  const filtersEl = document.getElementById('resourceFilters');
  if (filtersEl) {
    filtersEl.addEventListener('click', function(e) {
      const pill = e.target.closest('.resource-filter-pill');
      if (!pill) return;
      resourcesState.filter = pill.getAttribute('data-cat');
      filtersEl.querySelectorAll('.resource-filter-pill').forEach(function(p) {
        p.classList.toggle('active', p.getAttribute('data-cat') === resourcesState.filter);
      });
      renderResourceList();
    });
  }

  // Search input
  const searchInput = document.getElementById('resourceSearch');
  if (searchInput) {
    searchInput.value = resourcesState.searchQuery || '';
    searchInput.addEventListener('input', function() {
      resourcesState.searchQuery = searchInput.value;
      renderResourceList();
    });
  }

  // Drive picker button
  const driveBtn = document.getElementById('resourceDriveBtn');
  if (driveBtn) {
    driveBtn.addEventListener('click', function() {
      pickerState.context = 'resource';
      openDrivePicker();
    });
  }

  // Add button
  const addBtn = document.getElementById('resourceAddBtn');
  if (addBtn) {
    addBtn.addEventListener('click', function() {
      const title = document.getElementById('resourceTitle').value.trim();
      const url   = document.getElementById('resourceUrl').value.trim();
      const desc  = document.getElementById('resourceDesc').value.trim();
      const cat   = document.getElementById('resourceCategory').value;

      if (!title || !url) {
        showToast('Add a title and URL.', 'error');
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        showToast('URL must start with http:// or https://', 'error');
        return;
      }

      addBtn.disabled = true;
      addDoc(collection(db, 'resources'), {
        title:       title,
        url:         url,
        description: desc,
        category:    cat,
        addedBy:     state.user.uid,
        addedByName: state.user.displayName || state.user.email || 'Member',
        createdAt:   serverTimestamp()
      }).then(function() {
        document.getElementById('resourceTitle').value = '';
        document.getElementById('resourceUrl').value = '';
        document.getElementById('resourceDesc').value = '';
        document.getElementById('resourceCategory').value = 'general';
        setResourceFormOpen(false);
        showToast('Resource shared with the network.', 'success');
      }).catch(function(err) {
        logError('Add resource error', err);
        showToast('Could not share this resource.', 'error');
      }).finally(function() {
        addBtn.disabled = false;
      });
    });
  }

  // Subscribe to resources collection
  if (resourcesState.unsubscribe) resourcesState.unsubscribe();

  const q = query(collection(db, 'resources'), orderBy('createdAt', 'desc'));
  resourcesState.unsubscribe = onSnapshot(q, function(snap) {
    resourcesState.resources = snap.docs.map(function(d) {
      const data = d.data();
      data.id = d.id;
      return data;
    });
    renderResourceList();
  }, function(err) {
    logError('Resources subscribe error', err);
  });
};
