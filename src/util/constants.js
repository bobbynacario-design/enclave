export const ASSET_VERSION = 'v172';

// The three original circles, owned by the owner-admin. Admins can assign
// these directly; every other circle is created and managed by its members
// through the `circles` Cloud Function.
export const LEGACY_CIRCLES = [
  { id: 'hustle-hub',   name: 'Hustle Hub' },
  { id: 'work-network', name: 'Work Network' },
  { id: 'family',       name: 'Family' }
];

export const LEGACY_CIRCLE_IDS = LEGACY_CIRCLES.map(function(c) { return c.id; });

// Feed and event queries filter with `where('circle', 'in', ...)`, which
// accepts at most 30 values ('all' plus up to 29 circles).
export const MAX_VISIBLE_CIRCLES = 29;

export const FEED_PAGE_SIZE = 20;
export const STRATEGY_APP_URL = 'https://bobbynacario-design.github.io/forensic-bi-strategy/';

export const VALID_PAGES = {
  feed:      true,
  events:    true,
  members:   true,
  admin:     true,
  messages:  true,
  projects:  true,
  resources: true,
  briefings: true,
  notifications: true,
  circles:   true
};

export const BRIEFING_SECTION_META = {
  global:  { label: 'Global',      color: '#378ADD' },
  ph:      { label: 'Philippines',  color: '#BA7517' },
  ai:      { label: 'AI',           color: '#7F77DD' },
  markets: { label: 'Markets',      color: '#1D9E75' },
  ev:      { label: 'EV',           color: '#639922' }
};

export const ENCLAVE_CONTACT_EMAIL = 'bobbynacario@gmail.com';
