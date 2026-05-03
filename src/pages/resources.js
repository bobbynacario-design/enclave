// Firebase
import {
  doc,
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
    const msg = q ? 'No resources match your search.' : (resourcesState.filter === 'saved' ? 'No saved resources yet.' : 'No resources yet.');
    listEl.innerHTML = '<p class="text-muted">' + msg + '</p>';
    return;
  }

  listEl.innerHTML = filtered.map(function(r) {
    const cat = RESOURCE_CATEGORIES[r.category] || RESOURCE_CATEGORIES.general;
    const desc = r.description ? '<p class="resource-desc">' + escapeHTML(r.description) + '</p>' : '';
    const isSaved = resourcesState.savedResources.indexOf(r.id) !== -1;
    const bookmarkBtn = '<button class="btn-ghost resource-bookmark' + (isSaved ? ' saved' : '') + '" data-bookmark="' + r.id + '" title="' + (isSaved ? 'Remove bookmark' : 'Bookmark') + '">' + (isSaved ? '&#9733;' : '&#9734;') + '</button>';
    const deleteBtn = state.isAdmin
      ? '<button class="btn-ghost resource-delete" data-id="' + r.id + '" title="Delete">&#128465;</button>'
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
      const idx = resourcesState.savedResources.indexOf(rid);
      if (idx !== -1) {
        resourcesState.savedResources.splice(idx, 1);
      } else {
        resourcesState.savedResources.push(rid);
      }
      // Persist to user doc
      updateDoc(doc(db, 'users', state.user.uid), {
        savedResources: resourcesState.savedResources
      }).catch(function(err) {
        logError('Save bookmark error', err);
      });
      renderResourceList();
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

export const initResourcesPage = function() {
  // Show add form for all signed-in members
  const addForm = document.getElementById('resourceAddForm');
  if (addForm && state.user) addForm.style.display = 'block';

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

      if (!title || !url) return;
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
      }).catch(function(err) {
        logError('Add resource error', err);
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
