// Firebase
import {
  doc,
  getDoc,
  collection,
  addDoc,
  getDocs,
  serverTimestamp,
  Timestamp,
  query,
  where,
  orderBy,
  limit,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js';
import { db } from '../../firebase.js';

// App state
import { state, eventsState } from '../state.js';

// Utilities
import { escapeHTML, escapeAttr } from '../util/escape.js';
import { formatCalendarMonthLabel } from '../util/time.js';
import { circleLabel, getVisibleCircles, renderCircleOptions } from '../util/circles.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { showNoticeModal } from '../ui/modals.js';

// Cross-page
import { writeNotification } from './notifications.js';

const renderTimeOptions = function(selectedValue) {
  var options = [];

  for (var hour = 0; hour < 24; hour++) {
    for (var minute = 0; minute < 60; minute += 30) {
      var hh = String(hour).padStart(2, '0');
      var mm = String(minute).padStart(2, '0');
      var value = hh + ':' + mm;
      var labelDate = new Date(2000, 0, 1, hour, minute);
      var label = labelDate.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      });
      var selected = value === selectedValue ? ' selected' : '';
      options.push('<option value="' + value + '"' + selected + '>' + escapeHTML(label) + '</option>');
    }
  }

  return options.join('');
};

const calendarPickerState = {
  activeFieldId: '',
  fields: {}
};

const formatDateValue = function(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  var year = String(date.getFullYear());
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
};

const parseDateValue = function(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;

  var parts = value.split('-');
  var year = Number(parts[0]);
  var month = Number(parts[1]) - 1;
  var day = Number(parts[2]);
  var date = new Date(year, month, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
};

const formatDateButtonLabel = function(value) {
  var date = parseDateValue(value);
  if (!date) return 'Select a date';

  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

const renderDatePickerField = function(inputId, label, value) {
  return '' +
    '<label class="profile-section-title" for="' + inputId + 'Trigger">' + escapeHTML(label) + '</label>' +
    '<div class="calendar-field" data-calendar-field="' + escapeAttr(inputId) + '">' +
      '<input type="hidden" id="' + escapeAttr(inputId) + '" value="' + escapeAttr(value) + '" />' +
      '<button type="button" id="' + escapeAttr(inputId) + 'Trigger" class="edit-input calendar-trigger" aria-haspopup="dialog" aria-expanded="false">' +
        '<span class="calendar-trigger-label">' + escapeHTML(formatDateButtonLabel(value)) + '</span>' +
        '<span class="calendar-trigger-icon">&#128197;</span>' +
      '</button>' +
      '<div class="calendar-popover" id="' + escapeAttr(inputId) + 'Popover" hidden></div>' +
    '</div>';
};

const closeActiveCalendarPicker = function() {
  var fieldId = calendarPickerState.activeFieldId;
  if (!fieldId) return;

  var field = calendarPickerState.fields[fieldId];
  calendarPickerState.activeFieldId = '';

  if (!field) return;

  field.popover.hidden = true;
  field.trigger.setAttribute('aria-expanded', 'false');
  field.wrapper.classList.remove('calendar-open');
};

const renderCalendarPopover = function(fieldId) {
  var field = calendarPickerState.fields[fieldId];
  if (!field) return;

  var selectedValue = field.hidden.value;
  var todayValue = formatDateValue(new Date());
  var firstDay = new Date(field.viewYear, field.viewMonth, 1).getDay();
  var daysInMonth = new Date(field.viewYear, field.viewMonth + 1, 0).getDate();
  var weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var cells = [];

  for (var blank = 0; blank < firstDay; blank++) {
    cells.push('<span class="calendar-day calendar-day-empty" aria-hidden="true"></span>');
  }

  for (var day = 1; day <= daysInMonth; day++) {
    var dateValue = formatDateValue(new Date(field.viewYear, field.viewMonth, day));
    var classes = ['calendar-day'];

    if (dateValue === selectedValue) classes.push('is-selected');
    if (dateValue === todayValue) classes.push('is-today');

    cells.push(
      '<button type="button" class="' + classes.join(' ') + '" data-calendar-date="' + dateValue + '">' +
        day +
      '</button>'
    );
  }

  field.popover.innerHTML =
    '<div class="calendar-shell">' +
      '<div class="calendar-toolbar">' +
        '<button type="button" class="calendar-nav-btn" data-calendar-nav="prev" aria-label="Previous month">&#8249;</button>' +
        '<div class="calendar-month-label">' + escapeHTML(formatCalendarMonthLabel(field.viewYear, field.viewMonth)) + '</div>' +
        '<button type="button" class="calendar-nav-btn" data-calendar-nav="next" aria-label="Next month">&#8250;</button>' +
      '</div>' +
      '<div class="calendar-weekdays">' +
        weekdayLabels.map(function(label) {
          return '<span class="calendar-weekday">' + label + '</span>';
        }).join('') +
      '</div>' +
      '<div class="calendar-grid">' + cells.join('') + '</div>' +
    '</div>';
};

const bindDatePickerField = function(inputId) {
  var wrapper = document.querySelector('[data-calendar-field="' + inputId + '"]');
  var hidden = document.getElementById(inputId);
  var trigger = document.getElementById(inputId + 'Trigger');
  var popover = document.getElementById(inputId + 'Popover');

  if (!wrapper || !hidden || !trigger || !popover) return;

  var selectedDate = parseDateValue(hidden.value) || new Date();
  var field = {
    wrapper: wrapper,
    hidden: hidden,
    trigger: trigger,
    popover: popover,
    viewYear: selectedDate.getFullYear(),
    viewMonth: selectedDate.getMonth(),
    updateLabel: function() {
      var label = trigger.querySelector('.calendar-trigger-label');
      if (label) {
        label.textContent = formatDateButtonLabel(hidden.value);
      }
    }
  };

  calendarPickerState.fields[inputId] = field;
  field.updateLabel();
  renderCalendarPopover(inputId);

  trigger.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();

    var isOpening = calendarPickerState.activeFieldId !== inputId || popover.hidden;
    closeActiveCalendarPicker();

    if (!isOpening) return;

    var currentDate = parseDateValue(hidden.value) || new Date();
    field.viewYear = currentDate.getFullYear();
    field.viewMonth = currentDate.getMonth();
    renderCalendarPopover(inputId);
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    wrapper.classList.add('calendar-open');
    calendarPickerState.activeFieldId = inputId;
  });

  popover.addEventListener('click', function(e) {
    var navBtn = e.target.closest('[data-calendar-nav]');
    if (navBtn) {
      if (navBtn.dataset.calendarNav === 'prev') {
        field.viewMonth -= 1;
        if (field.viewMonth < 0) {
          field.viewMonth = 11;
          field.viewYear -= 1;
        }
      } else {
        field.viewMonth += 1;
        if (field.viewMonth > 11) {
          field.viewMonth = 0;
          field.viewYear += 1;
        }
      }

      renderCalendarPopover(inputId);
      return;
    }

    var dayBtn = e.target.closest('[data-calendar-date]');
    if (!dayBtn) return;

    hidden.value = dayBtn.dataset.calendarDate;
    field.updateLabel();
    renderCalendarPopover(inputId);
    closeActiveCalendarPicker();
  });
};

document.addEventListener('click', function(e) {
  var fieldId = calendarPickerState.activeFieldId;
  if (!fieldId) return;

  var field = calendarPickerState.fields[fieldId];
  if (!field || !field.wrapper.contains(e.target)) {
    closeActiveCalendarPicker();
  }
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeActiveCalendarPicker();
  }
});

const getUpcomingEventsThreshold = function() {
  return Timestamp.fromDate(new Date(Date.now() - 3600000));
};

// ─── Right panel: upcoming events ────────────────────────────────────────────
export const loadPanelEvents = function() {
  var el = document.getElementById('panelEvents');
  if (!el) {
    return;
  }

  var q = query(
    collection(db, 'events'),
    where('circle', 'in', getVisibleCircles(state)),
    where('date', '>=', getUpcomingEventsThreshold()),
    orderBy('date', 'asc'),
    limit(4)
  );
  getDocs(q).then(function(snap) {
    var items = [];
    snap.forEach(function(d) {
      var data = d.data();
      items.push(data);
    });

    if (items.length === 0) {
      el.className = 'panel-empty';
      el.textContent = 'No upcoming events.';
      return;
    }

    el.className = 'panel-events';
    el.innerHTML = items.map(function(ev) {
      var titleEsc = escapeHTML(ev.title || 'Untitled');
      var when = '';
      if (ev.date && typeof ev.date.toDate === 'function') {
        var d = ev.date.toDate();
        when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
          ' · ' +
          d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      }
      var locEsc = escapeHTML(ev.location || '');
      return '' +
        '<div class="panel-event">' +
          '<div class="panel-event-title">' + titleEsc + '</div>' +
          '<div class="panel-event-meta">' + escapeHTML(when) + '</div>' +
          (locEsc ? '<div class="panel-event-meta">' + locEsc + '</div>' : '') +
        '</div>';
    }).join('');
  }).catch(function(err) {
    logError('Failed to load panel events', err);
    el.className = 'panel-empty';
    el.textContent = 'Failed to load events.';
  });
};

// ─── Events: init ────────────────────────────────────────────────────────────
export const initEventsPage = function() {
  var composer = document.getElementById('eventAdminComposer');
  var createBtn = document.getElementById('createEventBtn');
  if (createBtn) {
    createBtn.hidden = true;
    createBtn.addEventListener('click', function() {
      window.enclaveCreateEvent();
    });
  }

  var modalCloseBtn = document.querySelector('#eventModal .profile-modal-close');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  var modalBackdrop = document.querySelector('#eventModal .profile-modal-backdrop');
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  // Always render the composer if user is signed in. Firestore rules enforce
  // admin-only writes — non-admins will get a clear permission error.
  if (composer) {
    composer.innerHTML = '';
  }

  if (state.isAdmin) {
    renderInlineEventComposer();
  }

  var eventsList = document.getElementById('eventsList');
  if (eventsList) {
    eventsList.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-ics]');
      if (!btn) return;
      e.stopPropagation();
      var eventId = btn.dataset.ics;
      var allEvents = (eventsState.upcoming || []).concat(eventsState.past || []);
      var ev = allEvents.find(function(item) { return item.id === eventId; });
      if (ev) { generateIcs(ev); }
    });
  }

  loadEvents();
};

// ─── Events: load upcoming ───────────────────────────────────────────────────
const loadEvents = function() {
  var list = document.getElementById('eventsList');
  if (!list) return;

  var threshold = getUpcomingEventsThreshold();
  var upcomingQuery = query(
    collection(db, 'events'),
    where('circle', 'in', getVisibleCircles(state)),
    where('date', '>=', threshold),
    orderBy('date', 'asc')
  );
  var pastQuery = query(
    collection(db, 'events'),
    where('circle', 'in', getVisibleCircles(state)),
    where('date', '<', threshold),
    orderBy('date', 'asc')
  );

  Promise.all([getDocs(upcomingQuery), getDocs(pastQuery)]).then(function(results) {
    var upcoming = [];
    var past = [];

    results[0].forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      upcoming.push(data);
    });

    results[1].forEach(function(d) {
      var data = d.data();
      data.id = d.id;
      past.push(data);
    });

    past.reverse();
    eventsState.upcoming = upcoming;
    eventsState.past = past;
    renderEventsList();
  }).catch(function(err) {
    logError('Failed to load events', err);
    list.innerHTML = '<div class="card"><p class="text-muted">Failed to load events. Check Firestore rules.</p></div>';
  });
};

const bindEventRsvpButtons = function(container) {
  if (!container) return;

  container.querySelectorAll('[data-rsvp]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      handleRsvp(btn.dataset.rsvp, btn);
    });
  });

  if (!state.user) return;

  eventsState.upcoming.forEach(function(ev) {
    var rsvpRef = doc(db, 'events', ev.id, 'rsvps', state.user.uid);
    getDoc(rsvpRef).then(function(snap) {
      if (!snap.exists()) return;

      var btn = container.querySelector('[data-rsvp="' + ev.id + '"]');
      if (!btn) return;

      btn.classList.add('rsvped');
      btn.textContent = rsvpButtonLabel(ev.rsvpCount, true);
    }).catch(function() { /* ignore */ });
  });
};

// ─── Events: render list ─────────────────────────────────────────────────────
const renderEventsList = function() {
  var list = document.getElementById('eventsList');
  if (!list) return;

  var hasUpcoming = eventsState.upcoming.length > 0;
  var hasPast = eventsState.past.length > 0;

  if (!hasUpcoming && !hasPast) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No events yet</div><p class="empty-state-text">' +
      (state.isAdmin ? 'Create the first event to get the calendar going.' : 'Upcoming gatherings and important dates will appear here.') +
      '</p></div>';
    return;
  }

  var upcomingHtml = hasUpcoming
    ? eventsState.upcoming.map(function(ev) {
      return renderEventCard(ev, { isPast: false });
    }).join('')
    : '<div class="empty-state"><div class="empty-state-title">No upcoming events</div><p class="empty-state-text">Check back soon for new gatherings.</p></div>';

  var pastHtml = hasPast
    ? eventsState.past.map(function(ev) {
      return renderEventCard(ev, { isPast: true });
    }).join('')
    : '<div class="empty-state"><div class="empty-state-title">No past events</div><p class="empty-state-text">Past events will be archived here.</p></div>';

  list.innerHTML =
    '<section class="events-section">' +
      '<div class="events-section-header">' +
        '<h2 class="events-section-title">Upcoming Events</h2>' +
        '<p class="text-muted">What is coming up next.</p>' +
      '</div>' +
      '<div class="events-list-stack" id="upcomingEventsList">' + upcomingHtml + '</div>' +
    '</section>' +
    '<section class="events-section">' +
      '<div class="events-section-header">' +
        '<h2 class="events-section-title">Past Events</h2>' +
        '<p class="text-muted">A simple archive of gatherings that already happened.</p>' +
      '</div>' +
      '<div class="events-list-stack" id="pastEventsList">' + pastHtml + '</div>' +
    '</section>';

  bindEventRsvpButtons(document.getElementById('upcomingEventsList'));
};

// ─── Events: render single card ──────────────────────────────────────────────
const renderEventCard = function(ev, opts) {
  opts = opts || {};
  var titleEsc    = escapeHTML(ev.title    || 'Untitled');
  var locationEsc = escapeHTML(ev.location || 'TBD');
  var circleLbl   = escapeHTML(circleLabel(ev.circle || 'all'));
  var descEsc     = escapeHTML(ev.description || '');

  var when = 'TBD';
  if (ev.date && typeof ev.date.toDate === 'function') {
    var d = ev.date.toDate();
    when = d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric'
    }) + ' · ' + d.toLocaleTimeString(undefined, {
      hour: 'numeric', minute: '2-digit'
    });
  }

  var rsvpCount = (typeof ev.rsvpCount === 'number') ? ev.rsvpCount : 0;
  var statusHtml = opts.isPast
    ? '<span class="event-status-label">Past Event</span>'
    : '';
  var icsBtn = ev.id
    ? '<button class="btn btn-ghost" data-ics="' + escapeAttr(ev.id) + '">Add to calendar</button>'
    : '';
  var actionsHtml = opts.isPast
    ? '<div class="event-actions event-actions-static">' +
        '<span class="text-muted">RSVP closed</span>' +
        icsBtn +
      '</div>'
    : '<div class="event-actions">' +
        '<button class="btn btn-primary" data-rsvp="' + escapeAttr(ev.id) + '">' + rsvpButtonLabel(rsvpCount, false) + '</button>' +
        icsBtn +
      '</div>';

  return '' +
    '<div class="event-card' + (opts.isPast ? ' event-card-past' : '') + '">' +
      '<div class="event-card-header">' +
        '<div>' +
          '<div class="event-title">' + titleEsc + '</div>' +
          statusHtml +
        '</div>' +
        '<span class="post-circle">' + circleLbl + '</span>' +
      '</div>' +
      '<div class="event-meta">' +
        '<div class="event-meta-row">&#128197; ' + escapeHTML(when) + '</div>' +
        '<div class="event-meta-row">&#128205; ' + locationEsc + '</div>' +
      '</div>' +
      (descEsc ? '<div class="event-desc">' + descEsc + '</div>' : '') +
      actionsHtml +
    '</div>';
};

// ─── Events: RSVP toggle ─────────────────────────────────────────────────────
const handleRsvp = function(eventId, btn) {
  if (!state.user || !eventId) return;

  var eventRef = doc(db, 'events', eventId);
  var rsvpRef = doc(db, 'events', eventId, 'rsvps', state.user.uid);

  btn.disabled = true;

  runTransaction(db, function(transaction) {
    return transaction.get(eventRef).then(function(eventSnap) {
      if (!eventSnap.exists()) throw new Error('Event not found.');

      return transaction.get(rsvpRef).then(function(rsvpSnap) {
        var eventData = eventSnap.data() || {};
        var currentCount = typeof eventData.rsvpCount === 'number' ? eventData.rsvpCount : 0;

        var nextCount;
        if (rsvpSnap.exists()) {
          nextCount = currentCount > 0 ? currentCount - 1 : 0;
          transaction.delete(rsvpRef);
          transaction.update(eventRef, { rsvpCount: nextCount });
          return {
            count:    nextCount,
            isRsvped: false
          };
        }

        nextCount = currentCount + 1;
        transaction.set(rsvpRef, {
          uid:       state.user.uid,
          name:      state.user.displayName || state.user.email,
          email:     state.user.email,
          timestamp: serverTimestamp()
        });
        transaction.update(eventRef, { rsvpCount: nextCount });
        return {
          count:    nextCount,
          isRsvped: true
        };
      });
    });
  }).then(function(result) {
    setLocalEventRsvpCount(eventId, result.count);
    btn.classList.toggle('rsvped', result.isRsvped);
    btn.textContent = rsvpButtonLabel(result.count, result.isRsvped);
    btn.disabled = false;

    // Notify event creator on RSVP (not un-RSVP)
    if (result.isRsvped) {
      var allEvents = (eventsState.upcoming || []).concat(eventsState.past || []);
      var evt = allEvents.find(function(e) { return e.id === eventId; });
      if (evt && evt.createdBy && evt.createdBy !== state.user.uid) {
        var actor = state.user.displayName || state.user.email || 'Member';
        writeNotification(evt.createdBy, 'event-rsvp', actor + ' RSVPed to "' + (evt.title || 'your event') + '"', { page: 'events', params: {} });
      }
    }
  }).catch(function(err) {
    logError('Failed to update RSVP', err);
    showToast('Failed to update RSVP. Check console for details.', 'error');
    btn.disabled = false;
  });
};

// ─── Events: create event modal (admin only) ────────────────────────────────
const openCreateEventModal = function() {
  if (!state.isAdmin) return;
  var modal = document.getElementById('eventModal');
  var body  = document.getElementById('eventModalBody');
  if (!modal || !body) return;

  // Default to tomorrow 7pm
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var defaultDate = tomorrow.toISOString().slice(0, 10);

  body.innerHTML =
    '<div class="profile-header">' +
      '<div class="profile-header-meta">' +
        '<h2 class="profile-name">Create Event</h2>' +
        '<p class="text-muted">Add a new gathering to the enclave.</p>' +
      '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evTitle">Title</label>' +
      '<input type="text" id="evTitle" class="edit-input" maxlength="80" placeholder="e.g. Poker Night" />' +
    '</div>' +
    '<div class="profile-section event-date-row">' +
      '<div style="flex:1;">' +
        renderDatePickerField('evDate', 'Date', defaultDate) +
      '</div>' +
      '<div style="flex:1;">' +
        '<label class="profile-section-title" for="evTime">Time</label>' +
        '<select id="evTime" class="edit-input">' +
          renderTimeOptions('19:00') +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evLocation">Location</label>' +
      '<input type="text" id="evLocation" class="edit-input" maxlength="120" placeholder="e.g. Bob\'s place" />' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evCircle">Circle</label>' +
      '<select id="evCircle" class="edit-input">' +
        '<option value="all">All</option>' +
        '<option value="hustle-hub">Hustle Hub</option>' +
        '<option value="work-network">Work Network</option>' +
        '<option value="family">Family</option>' +
      '</select>' +
    '</div>' +
    '<div class="profile-section">' +
      '<label class="profile-section-title" for="evDesc">Description</label>' +
      '<textarea id="evDesc" class="edit-input edit-textarea" rows="3" maxlength="400" placeholder="Optional details..."></textarea>' +
    '</div>' +
    '<div class="edit-actions">' +
      '<button class="btn" id="evCancelBtn">Cancel</button>' +
      '<button class="btn btn-primary" id="evSaveBtn">Create</button>' +
    '</div>';

  var cancelBtn = document.getElementById('evCancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      window.enclaveCloseEvent();
    });
  }

  var saveBtn = document.getElementById('evSaveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', function() {
      window.enclaveSubmitEvent();
    });
  }

  bindDatePickerField('evDate');

  modal.hidden = false;
};

const closeEventModal = function() {
  var modal = document.getElementById('eventModal');
  if (modal) modal.hidden = true;
};

const handleCreateEvent = function() {
  if (!state.isAdmin || !state.user) return;

  var title    = document.getElementById('evTitle').value.trim();
  var dateVal  = document.getElementById('evDate').value;
  var timeVal  = document.getElementById('evTime').value;
  var location = document.getElementById('evLocation').value.trim();
  var circle   = document.getElementById('evCircle').value;
  var desc     = document.getElementById('evDesc').value.trim();

  if (!title)    { showToast('Title is required.', 'error');    return; }
  if (!dateVal)  { showToast('Date is required.', 'error');     return; }
  if (!timeVal)  { showToast('Time is required.', 'error');     return; }
  if (!location) { showToast('Location is required.', 'error'); return; }

  // Combine date + time into a JS Date, then Firestore Timestamp
  var combined = new Date(dateVal + 'T' + timeVal);
  if (isNaN(combined.getTime())) {
    showToast('Invalid date/time.', 'error');
    return;
  }

  var saveBtn = document.getElementById('evSaveBtn');
  if (saveBtn) {
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Creating...';
  }

  var newEvent = {
    title:       title,
    date:        Timestamp.fromDate(combined),
    location:    location,
    circle:      circle,
    description: desc,
    createdBy:   state.user.uid,
    createdAt:   serverTimestamp(),
    rsvpCount:   0
  };

  addDoc(collection(db, 'events'), newEvent).then(function() {
    closeEventModal();
    loadEvents();
  }).catch(function(err) {
    logError('Failed to create event', err);
    showToast('Failed to create event. Check console for details.', 'error');
    if (saveBtn) {
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Create';
    }
  });
};

const renderInlineEventComposer = function() {
  var composer = document.getElementById('eventAdminComposer');
  if (!composer) return;

  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var defaultDate = tomorrow.toISOString().slice(0, 10);

  composer.innerHTML =
    '<div class="card">' +
      '<div class="page-header-row">' +
        '<div>' +
          '<h2 class="profile-name">Create Event</h2>' +
          '<p class="text-muted">Add a new gathering to the enclave.</p>' +
        '</div>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvTitle">Title</label>' +
        '<input type="text" id="inlineEvTitle" class="edit-input" maxlength="80" placeholder="e.g. Poker Night" />' +
      '</div>' +
      '<div class="profile-section event-date-row">' +
        '<div style="flex:1;">' +
          renderDatePickerField('inlineEvDate', 'Date', defaultDate) +
        '</div>' +
      '<div style="flex:1;">' +
        '<label class="profile-section-title" for="inlineEvTime">Time</label>' +
        '<select id="inlineEvTime" class="edit-input">' +
          renderTimeOptions('19:00') +
        '</select>' +
      '</div>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvLocation">Location</label>' +
        '<input type="text" id="inlineEvLocation" class="edit-input" maxlength="120" placeholder="e.g. Bob\'s place" />' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvCircle">Circle</label>' +
        '<select id="inlineEvCircle" class="edit-input">' + renderCircleOptions(true) + '</select>' +
      '</div>' +
      '<div class="profile-section">' +
        '<label class="profile-section-title" for="inlineEvDesc">Description</label>' +
        '<textarea id="inlineEvDesc" class="edit-input edit-textarea" rows="3" maxlength="400" placeholder="Optional details..."></textarea>' +
      '</div>' +
      '<div class="edit-actions">' +
        '<button type="button" class="btn btn-primary" id="inlineEvSaveBtn">Create Event</button>' +
      '</div>' +
    '</div>';

  // Direct onclick assignment — not addEventListener, not inline attribute.
  // This is the single most reliable handler wiring in the DOM.
  var btn = document.getElementById('inlineEvSaveBtn');
  if (btn) {
    btn.onclick = function() {
      btn.textContent = 'Working...';
      btn.disabled = true;
      setTimeout(function() {
        handleInlineCreateEvent();
      }, 0);
    };
  }

  bindDatePickerField('inlineEvDate');
};

const handleInlineCreateEvent = function() {
  if (!state.user) {
    showToast('Not signed in.', 'error');
    return;
  }

  var titleEl    = document.getElementById('inlineEvTitle');
  var dateEl     = document.getElementById('inlineEvDate');
  var timeEl     = document.getElementById('inlineEvTime');
  var locationEl = document.getElementById('inlineEvLocation');
  var circleEl   = document.getElementById('inlineEvCircle');
  var descEl     = document.getElementById('inlineEvDesc');
  var saveBtn    = document.getElementById('inlineEvSaveBtn');

  if (!titleEl || !dateEl || !timeEl || !locationEl || !circleEl || !descEl) {
    showToast('Form elements missing. See console.', 'error');
    return;
  }

  var title    = titleEl.value.trim();
  var dateVal  = dateEl.value;
  var timeVal  = timeEl.value;
  var location = locationEl.value.trim();
  var circle   = circleEl.value;
  var desc     = descEl.value.trim();

  var resetBtn = function() {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
  };

  if (!title)    { showToast('Title is required.', 'error');    resetBtn(); return; }
  if (!dateVal)  { showToast('Date is required.', 'error');     resetBtn(); return; }
  if (!timeVal)  { showToast('Time is required.', 'error');     resetBtn(); return; }
  if (!location) { showToast('Location is required.', 'error'); resetBtn(); return; }

  var combined = new Date(dateVal + 'T' + timeVal);
  if (isNaN(combined.getTime())) {
    showToast('Invalid date/time.', 'error');
    resetBtn();
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating...';
  }

  addDoc(collection(db, 'events'), {
    title:       title,
    date:        Timestamp.fromDate(combined),
    location:    location,
    circle:      circle,
    description: desc,
    createdBy:   state.user.uid,
    createdAt:   serverTimestamp(),
    rsvpCount:   0
  }).then(function(ref) {
    loadPanelEvents();
    titleEl.value = '';
    locationEl.value = '';
    descEl.value = '';
    circleEl.value = 'all';
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
    loadEvents();
  }).catch(function(err) {
    logError('Failed to create event', err);
    var msg;
    if (err.code === 'permission-denied') {
      msg = 'PERMISSION DENIED.\n\n' +
        'Firestore rejected the write. Two things to check:\n\n' +
        '1. Firebase Console → Firestore → Rules: paste the full ruleset that includes the /events/{eventId} block (with the /rsvps/{uid} subcollection) and click Publish.\n\n' +
        '2. Firebase Console → Firestore → users → your uid doc: the "role" field must be exactly the string "admin" (lowercase).';
    } else {
      msg = 'Failed to create event.\n\n' + (err.code || '') + '\n' + (err.message || '');
    }
    showNoticeModal('Create event failed', msg);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create Event';
    }
  });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const icsEscape = function(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
};

const toIcsDate = function(date) {
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return '' +
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) + 'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) + 'Z';
};

const foldIcsLine = function(line) {
  if (line.length <= 75) return line;
  var out = '';
  while (line.length > 75) {
    out += line.slice(0, 75) + '\r\n ';
    line = line.slice(75);
  }
  return out + line;
};

const generateIcs = function(ev) {
  if (!ev.date || typeof ev.date.toDate !== 'function') {
    showToast('This event has no date — cannot export.', 'error');
    return;
  }

  var start = ev.date.toDate();
  var end   = new Date(start.getTime() + 3600000); // default DTEND = +1 hour
  var now   = new Date();
  var uid   = (ev.id || String(now.getTime())) + '@enclave-social';

  var lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Enclave//Events//EN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + toIcsDate(now),
    'DTSTART:' + toIcsDate(start),
    'DTEND:' + toIcsDate(end),
    'SUMMARY:' + icsEscape(ev.title || 'Untitled')
  ];

  if (ev.description) { lines.push('DESCRIPTION:' + icsEscape(ev.description)); }
  if (ev.location)    { lines.push('LOCATION:'    + icsEscape(ev.location));    }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  var content = lines.map(foldIcsLine).join('\r\n');
  var blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = ((ev.title || 'event').replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'event') + '.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const rsvpButtonLabel = function(count, isRsvped) {
  var total = typeof count === 'number' ? count : 0;
  var countLabel = total > 0 ? ' (' + total + ')' : '';
  return (isRsvped ? 'Going' : 'RSVP') + countLabel;
};

const setLocalEventRsvpCount = function(eventId, count) {
  ['upcoming', 'past'].forEach(function(bucket) {
    eventsState[bucket] = eventsState[bucket].map(function(eventItem) {
      if (eventItem.id !== eventId) return eventItem;
      eventItem.rsvpCount = count;
      return eventItem;
    });
  });
};

// Globally-exposed functions for inline onclick handlers in page HTML.
window.enclaveCreateEvent = function() {
  if (!state.isAdmin) return;
  openCreateEventModal();
};

window.enclaveCloseEvent = function() {
  closeEventModal();
};

window.enclaveSubmitEvent = function() { handleCreateEvent(); };

window.enclaveInlineCreate = function() {
  handleInlineCreateEvent();
};
