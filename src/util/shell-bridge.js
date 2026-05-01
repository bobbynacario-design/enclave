// Shell-bridge: page modules call these to invoke shell-level
// operations without importing app.js. App.js registers the real
// implementations at module load time.

let sidebarSyncer = null;
let urlSyncer = null;
let pageLoader = null;
let appURLGetter = null;
let panelCirclesLoader = null;
let shellRenderer = null;
let urlApplier = null;

export const registerSidebarSyncer      = function(fn) { sidebarSyncer = fn; };
export const registerURLSyncer          = function(fn) { urlSyncer = fn; };
export const registerPageLoader         = function(fn) { pageLoader = fn; };
export const registerAppURLGetter       = function(fn) { appURLGetter = fn; };
export const registerPanelCirclesLoader = function(fn) { panelCirclesLoader = fn; };
export const registerShellRenderer      = function(fn) { shellRenderer = fn; };
export const registerURLApplier         = function(fn) { urlApplier = fn; };

export const syncSidebarSelection = function() {
  if (sidebarSyncer) sidebarSyncer();
};

export const syncURLState = function() {
  if (urlSyncer) urlSyncer();
};

export const loadPage = function(pageName, params) {
  if (pageLoader) pageLoader(pageName, params);
};

export const getAppURL = function() {
  return appURLGetter ? appURLGetter() : '';
};

export const loadPanelCircles = function() {
  if (panelCirclesLoader) panelCirclesLoader();
};

export const renderShell = function() {
  if (shellRenderer) shellRenderer();
};

export const applyURLState = function() {
  if (urlApplier) urlApplier();
};
