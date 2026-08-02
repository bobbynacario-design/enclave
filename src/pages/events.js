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
import { circleLabel, getVisibleCircles, getInitials, renderCircleOptions } from '../util/circles.js';
import { logError } from '../util/log.js';

// UI helpers
import { showToast } from '../ui/toast.js';
import { showNoticeModal } from '../ui/modals.js';

// Cross-page
import { writeNotification } from './notifications.js';

var eventsView = 'upcoming';
var eventsCircleFilter = 'all';
var eventsSearch = '';
var eventsSearchTimer = null;

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

var formatEventDateBlock = function(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return { month: 'TBD', day: '—', weekday: '' };
  }
  return {
    month:   date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
    day:     String(date.getDate()),
    weekday: date.toLocaleDateString(undefined, { weekday: 'short' })
  };
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
        '<button type="button" class="panel-event" data-open-events aria-label="Open events calendar">' +
          '<div class="panel-event-title">' + titleEsc + '</div>' +
          '<div class="panel-event-meta">' + escapeHTML(when) + '</div>' +
          (locEsc ? '<div class="panel-event-meta">' + locEsc + '</div>' : '') +
          '<span class="panel-event-action">View event &rarr;</span>' +
        '</button>';
    }).join('');
    el.querySelectorAll('[data-open-events]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        window.enclaveGoPage('events');
      });
    });
  }).catch(function(err) {
    logError('Failed to load panel events', err);
    el.className = 'panel-empty';
    el.textContent = 'Failed to load events.';
  });
};

// ─── Events: init ────────────────────────────────────────────────────────────
export const initEventsPage = function() {
  eventsView = 'upcoming';
  eventsCircleFilter = 'all';
  eventsSearch = '';
  if (eventsSearchTimer) window.clearTimeout(eventsSearchTimer);
  eventsSearchTimer = null;

  var composer = document.getElementById('eventAdminComposer');

  if (composer) {
    composer.innerHTML = '';
  }

  if (state.isAdmin) {
    renderInlineEventComposer();
  }

  wireEventDiscovery();

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

const syncEventViewUI = function() {
  document.querySelectorAll('[data-events-view]').forEach(function(btn) {
    var active = btn.dataset.eventsView === eventsView;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
};

const wireEventDiscovery = function() {
  var searchInput = document.getElementById('eventsSearchInput');
  if (searchInput) searchInput.oninput = function() {
    eventsSearch = searchInput.value.trim();
    if (eventsSearchTimer) window.clearTimeout(eventsSearchTimer);
    eventsSearchTimer = window.setTimeout(function() {
      eventsSearchTimer = null;
      renderEventsList();
    }, 180);
  };

  var circleSelect = document.getElementById('eventsCircleFilter');
  if (circleSelect) {
    circleSelect.innerHTML = getVisibleCircles(state).map(function(circleId) {
      return '<option value="' + escapeAttr(circleId) + '">' +
        escapeHTML(circleId === 'all' ? 'All circles' : circleLabel(circleId)) +
      '</option>';
    }).join('');
    circleSelect.onchange = function() {
      eventsCircleFilter = circleSelect.value;
      renderEventsList();
    };
  }

  document.querySelectorAll('[data-events-view]').forEach(function(btn) {
    btn.onclick = function() {
      eventsView = btn.dataset.eventsView;
      syncEventViewUI();
      renderEventsList();
    };
  });
  syncEventViewUI();
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
    var resultsSummary = document.getElementById('eventsResultsSummary');
    var overview = document.getElementById('eventsOverview');
    if (resultsSummary) resultsSummary.textContent = 'Events unavailable';
    if (overview) {
      overview.innerHTML = '<div class="event-overview-card event-overview-error"><span class="event-overview-value event-overview-value-text">Could not load the calendar</span><span class="event-overview-label">Check your connection and try again</span></div>';
    }
    list.innerHTML = '<div class="empty-state events-empty-state"><div class="empty-state-title">Could not load events</div><p class="empty-state-text">Check your connection and try again.</p></div>';
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
      btn.innerHTML = rsvpButtonLabel(ev.rsvpCount, true);
    }).catch(function() { /* ignore */ });
  });
};

const getAttendeeDisplayName = function(attendee) {
  var name = String(attendee && (attendee.name || attendee.email) || 'Member').trim();
  if (name.indexOf('@') !== -1) name = name.split('@')[0];
  return name || 'Member';
};

const getAttendeeSummary = function(attendees) {
  var includesCurrentUser = !!(state.user && attendees.some(function(attendee) {
    return attendee.uid === state.user.uid;
  }));
  var others = attendees.filter(function(attendee) {
    return !state.user || attendee.uid !== state.user.uid;
  });

  if (includesCurrentUser) {
    if (!others.length) return "You're going";
    return 'You and ' + others.length + ' ' + (others.length === 1 ? 'other are' : 'others are') + ' going';
  }

  if (attendees.length === 1) return getAttendeeDisplayName(attendees[0]) + ' is going';
  if (attendees.length === 2) {
    return getAttendeeDisplayName(attendees[0]) + ' and ' + getAttendeeDisplayName(attendees[1]) + ' are going';
  }
  return getAttendeeDisplayName(attendees[0]) + ', ' + getAttendeeDisplayName(attendees[1]) +
    ' and ' + (attendees.length - 2) + ' ' + (attendees.length === 3 ? 'other' : 'others') + ' are going';
};

const renderLoadedEventAttendees = function(slot, attendees) {
  slot.innerHTML = '';

  if (!attendees.length) {
    var empty = document.createElement('span');
    empty.className = 'event-attendees-empty';
    empty.textContent = 'Be the first to join';
    slot.appendChild(empty);
    return;
  }

  attendees.sort(function(a, b) {
    var aSelf = state.user && a.uid === state.user.uid ? 0 : 1;
    var bSelf = state.user && b.uid === state.user.uid ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    return getAttendeeDisplayName(a).localeCompare(getAttendeeDisplayName(b));
  });

  var avatars = document.createElement('div');
  avatars.className = 'event-attendee-avatars';
  avatars.setAttribute('aria-hidden', 'true');
  attendees.slice(0, 4).forEach(function(attendee) {
    var avatar = document.createElement('span');
    avatar.className = 'event-attendee-avatar';
    avatar.textContent = getInitials(getAttendeeDisplayName(attendee));
    avatars.appendChild(avatar);
  });
  if (attendees.length > 4) {
    var more = document.createElement('span');
    more.className = 'event-attendee-avatar event-attendee-more';
    more.textContent = '+' + (attendees.length - 4);
    avatars.appendChild(more);
  }

  var summary = document.createElement('span');
  summary.className = 'event-attendee-summary';
  summary.textContent = getAttendeeSummary(attendees);
  slot.appendChild(avatars);
  slot.appendChild(summary);
};

const loadEventAttendees = function(eventId, root) {
  root = root || document;
  var slot = root.querySelector('[data-event-attendees="' + eventId + '"]');
  if (!slot) return;

  getDocs(collection(db, 'events', eventId, 'rsvps')).then(function(snap) {
    var attendees = [];
    snap.forEach(function(d) {
      var data = d.data() || {};
      data.uid = data.uid || d.id;
      attendees.push(data);
    });
    renderLoadedEventAttendees(slot, attendees);
  }).catch(function(err) {
    logError('Failed to load event attendees', err);
    var count = Number(slot.dataset.attendeeCount || 0);
    slot.textContent = count > 0
      ? count + ' ' + (count === 1 ? 'person is' : 'people are') + ' going'
      : 'Be the first to join';
  });
};

const loadEventAttendeeLists = function(container) {
  if (!container) return;
  container.querySelectorAll('[data-event-attendees]').forEach(function(slot) {
    loadEventAttendees(slot.dataset.eventAttendees, container);
  });
};

// ─── Events: render list ─────────────────────────────────────────────────────
const renderEventsList = function() {
  var list = document.getElementById('eventsList');
  if (!list) return;

  var hasUpcoming = eventsState.upcoming.length > 0;
  var hasPast = eventsState.past.length > 0;

  var totalRsvps = eventsState.upcoming.reduce(function(total, ev) {
    return total + (typeof ev.rsvpCount === 'number' ? ev.rsvpCount : 0);
  }, 0);
  var nextEvent = eventsState.upcoming[0] || null;
  var nextDate = nextEvent && nextEvent.date && typeof nextEvent.date.toDate === 'function'
    ? nextEvent.date.toDate()
    : null;
  var nextLabel = nextEvent
    ? (nextEvent.title || 'Untitled') + (nextDate
      ? ' · ' + nextDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '')
    : 'Nothing scheduled';
  var overview = document.getElementById('eventsOverview');
  if (overview) {
    overview.innerHTML =
      '<div class="event-overview-card">' +
        '<span class="event-overview-value">' + eventsState.upcoming.length + '</span>' +
        '<span class="event-overview-label">Upcoming event' + (eventsState.upcoming.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      '<div class="event-overview-card">' +
        '<span class="event-overview-value">' + totalRsvps + '</span>' +
        '<span class="event-overview-label">Community RSVP' + (totalRsvps === 1 ? '' : 's') + '</span>' +
      '</div>' +
      '<div class="event-overview-card event-overview-next">' +
        '<span class="event-overview-value event-overview-value-text">' + escapeHTML(nextLabel) + '</span>' +
        '<span class="event-overview-label">Next on the calendar</span>' +
      '</div>';
  }

  var countUpcoming = document.querySelector('[data-events-count="upcoming"]');
  var countPast = document.querySelector('[data-events-count="past"]');
  if (countUpcoming) countUpcoming.textContent = eventsState.upcoming.length;
  if (countPast) countPast.textContent = eventsState.past.length;

  if (!hasUpcoming && !hasPast) {
    var emptySummary = document.getElementById('eventsResultsSummary');
    if (emptySummary) emptySummary.textContent = 'No events published yet';
    list.innerHTML = '<div class="empty-state"><div class="empty-state-title">No events yet</div><p class="empty-state-text">' +
      (state.isAdmin ? 'Create the first event to get the calendar going.' : 'Upcoming gatherings and important dates will appear here.') +
      '</p></div>';
    return;
  }

  var searchTerm = eventsSearch.toLowerCase();
  var matchesFilters = function(ev) {
    if (eventsCircleFilter !== 'all' && ev.circle !== eventsCircleFilter) return false;
    if (!searchTerm) return true;
    return [ev.title, ev.location, ev.description, circleLabel(ev.circle || 'all')]
      .join(' ').toLowerCase().indexOf(searchTerm) !== -1;
  };
  var filteredUpcoming = eventsState.upcoming.filter(matchesFilters);
  var filteredPast = eventsState.past.filter(matchesFilters);
  var visibleCount = (eventsView === 'past' ? filteredPast.length
    : eventsView === 'all' ? filteredUpcoming.length + filteredPast.length
      : filteredUpcoming.length);
  var resultsSummary = document.getElementById('eventsResultsSummary');
  if (resultsSummary) {
    resultsSummary.textContent = visibleCount + ' event' + (visibleCount === 1 ? '' : 's') +
      (eventsSearch ? ' matching "' + eventsSearch + '"' : '') +
      (eventsCircleFilter !== 'all' ? ' in ' + circleLabel(eventsCircleFilter) : '');
  }

  if (visibleCount === 0) {
    var resetView = eventsState.upcoming.length ? 'upcoming' : 'past';
    list.innerHTML = '<div class="empty-state events-empty-state"><div class="empty-state-title">No matching events</div><p class="empty-state-text">Try another view, circle, or search term.</p><button type="button" class="btn btn-ghost" data-reset-events-view>Show ' + resetView + ' events</button></div>';
    var resetBtn = list.querySelector('[data-reset-events-view]');
    if (resetBtn) resetBtn.onclick = function() {
      eventsView = resetView;
      eventsCircleFilter = 'all';
      eventsSearch = '';
      var searchInput = document.getElementById('eventsSearchInput');
      var circleSelect = document.getElementById('eventsCircleFilter');
      if (searchInput) searchInput.value = '';
      if (circleSelect) circleSelect.value = 'all';
      syncEventViewUI();
      renderEventsList();
    };
    return;
  }

  var upcomingHtml = filteredUpcoming.length
    ? filteredUpcoming.map(function(ev) {
      return renderEventCard(ev, { isPast: false });
    }).join('')
    : '';

  var pastHtml = filteredPast.length
    ? filteredPast.map(function(ev) {
      return renderEventCard(ev, { isPast: true });
    }).join('')
    : '';

  var upcomingSection = eventsView !== 'past' && upcomingHtml
    ? '<section class="events-section">' +
      '<div class="events-section-header">' +
        '<h2 class="events-section-title">Upcoming Events</h2>' +
        '<p class="text-muted">What is coming up next.</p>' +
      '</div>' +
      '<div class="events-list-stack" id="upcomingEventsList">' + upcomingHtml + '</div>' +
    '</section>'
    : '';
  var pastSection = eventsView !== 'upcoming' && pastHtml
    ? '<section class="events-section">' +
      '<div class="events-section-header">' +
        '<h2 class="events-section-title">Past Events</h2>' +
        '<p class="text-muted">A simple archive of gatherings that already happened.</p>' +
      '</div>' +
      '<div class="events-list-stack" id="pastEventsList">' + pastHtml + '</div>' +
    '</section>'
    : '';
  list.innerHTML = upcomingSection + pastSection;

  bindEventRsvpButtons(document.getElementById('upcomingEventsList'));
  loadEventAttendeeLists(document.getElementById('upcomingEventsList'));
};

// ─── Events: render single card ──────────────────────────────────────────────
const renderEventCard = function(ev, opts) {
  opts = opts || {};
  var titleEsc    = escapeHTML(ev.title    || 'Untitled');
  var locationEsc = escapeHTML(ev.location || 'TBD');
  var circleLbl   = escapeHTML(circleLabel(ev.circle || 'all'));
  var descEsc     = escapeHTML(ev.description || '');

  var eventDate = (ev.date && typeof ev.date.toDate === 'function') ? ev.date.toDate() : null;
  var dateBlock = formatEventDateBlock(eventDate);
  var timeStr   = eventDate
    ? eventDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : 'TBD';

  var rsvpCount = (typeof ev.rsvpCount === 'number') ? ev.rsvpCount : 0;
  var statusHtml = opts.isPast
    ? '<span class="event-status-label">Past Event</span>'
    : '';
  var icsBtn = ev.id
    ? '<button class="btn btn-ghost event-ics-btn" data-ics="' + escapeAttr(ev.id) + '" aria-label="Add to calendar">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>' +
          '<line x1="16" y1="2" x2="16" y2="6"></line>' +
          '<line x1="8" y1="2" x2="8" y2="6"></line>' +
          '<line x1="3" y1="10" x2="21" y2="10"></line>' +
        '</svg>' +
        '<span>Add to calendar</span>' +
      '</button>'
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
  var attendeesHtml = !opts.isPast
    ? '<div class="event-attendees" data-event-attendees="' + escapeAttr(ev.id) + '" data-attendee-count="' + rsvpCount + '" aria-live="polite">' +
        (rsvpCount > 0 ? 'Loading attendees...' : 'Be the first to join') +
      '</div>'
    : '';

  return '' +
    '<div class="event-card' + (opts.isPast ? ' event-card-past' : '') + '">' +
      '<div class="event-card-body">' +
        '<div class="event-date-block' + (opts.isPast ? ' event-date-block-past' : '') + '">' +
          '<div class="event-date-month">' + escapeHTML(dateBlock.month) + '</div>' +
          '<div class="event-date-day">'   + escapeHTML(dateBlock.day)   + '</div>' +
          '<div class="event-date-weekday">' + escapeHTML(dateBlock.weekday) + '</div>' +
        '</div>' +
        '<div class="event-card-content">' +
          '<div class="event-card-header">' +
            '<div>' +
              '<div class="event-title">' + titleEsc + '</div>' +
              statusHtml +
            '</div>' +
            '<span class="event-circle-pill">' + circleLbl + '</span>' +
          '</div>' +
          '<div class="event-meta">' +
            '<div class="event-meta-row">' +
              '<svg class="event-meta-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<circle cx="12" cy="12" r="10"></circle>' +
                '<polyline points="12 6 12 12 16 14"></polyline>' +
              '</svg>' +
              '<span>' + escapeHTML(timeStr) + '</span>' +
            '</div>' +
            '<div class="event-meta-row">' +
              '<svg class="event-meta-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>' +
                '<circle cx="12" cy="10" r="3"></circle>' +
              '</svg>' +
              '<span>' + locationEsc + '</span>' +
            '</div>' +
          '</div>' +
          (descEsc ? '<div class="event-desc">' + descEsc + '</div>' : '') +
          attendeesHtml +
          actionsHtml +
        '</div>' +
      '</div>' +
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
    btn.innerHTML = rsvpButtonLabel(result.count, result.isRsvped);
    btn.disabled = false;
    var attendeeSlot = document.querySelector('[data-event-attendees="' + eventId + '"]');
    if (attendeeSlot) attendeeSlot.dataset.attendeeCount = String(result.count);
    loadEventAttendees(eventId, document);

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
        '<div class="event-date-row-cell">' +
          renderDatePickerField('inlineEvDate', 'Date', defaultDate) +
        '</div>' +
      '<div class="event-date-row-cell">' +
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
      msg = 'You do not have permission to create events. Only admins can do this.';
    } else {
      msg = 'Failed to create event. Please try again or check the browser console for details.';
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
  var labelText = isRsvped ? 'Going' : 'RSVP';
  var countHtml = total > 0
    ? '<span class="rsvp-count">' + total + '</span>'
    : '';
  return labelText + countHtml;
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

