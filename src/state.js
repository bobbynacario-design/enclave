export const state = {
  currentPage:  'feed',
  user:         null,
  accessDenied: false,
  isAdmin:      false,
  circles:      [],
  googleAccessToken: ''
};

export const authFlowState = {
  busy: false
};

export const eventsState = {
  upcoming: [],
  past: []
};

export const feedState = {
  livePosts:   [],
  olderPosts:  [],
  filter:      'all',
  unsubscribe: null,
  hasMore:     false,
  loadingMore: false,
  lastDoc:     null,
  openComments: {},
  targetPostId: '',
  pendingTargetScroll: false
};

export const membersState = {
  members: []
};

export const adminState = {
  allowlist: [],
  usersByEmail: {}
};

export const messagesState = {
  members:                 [],
  conversations:           [],
  activePeerId:            null,
  activeConversationId:    null,
  thread:                  [],
  olderMessages:           [],
  hasMoreMessages:         false,
  loadingOlder:            false,
  oldestDoc:               null,
  totalUnread:             0,
  unsubscribeConversations: null,
  unsubscribeThread:        null
};

// Drive attachment state for compose box
export const driveAttachment = {
  fileUrl:  '',
  fileName: '',
  iconUrl:  ''
};

export const shellState = {
  unsubscribeOnline: null,
  presenceTimer:     null
};

export const resetMessagesState = function(fullReset) {
  if (messagesState.unsubscribeThread) {
    messagesState.unsubscribeThread();
    messagesState.unsubscribeThread = null;
  }

  messagesState.activePeerId = null;
  messagesState.activeConversationId = null;
  messagesState.thread = [];

  if (fullReset !== false) {
    if (messagesState.unsubscribeConversations) {
      messagesState.unsubscribeConversations();
      messagesState.unsubscribeConversations = null;
    }

    messagesState.members = [];
    messagesState.conversations = [];
    messagesState.totalUnread = 0;
  }
};

export const resetShellRealtime = function() {
  if (shellState.unsubscribeOnline) {
    shellState.unsubscribeOnline();
    shellState.unsubscribeOnline = null;
  }

  if (shellState.presenceTimer) {
    window.clearInterval(shellState.presenceTimer);
    shellState.presenceTimer = null;
  }

  if (notificationsState.unsubscribe) {
    notificationsState.unsubscribe();
    notificationsState.unsubscribe = null;
  }

  if (briefingsState.unsubscribeNotifier) {
    briefingsState.unsubscribeNotifier();
    briefingsState.unsubscribeNotifier = null;
  }
};

export const resetProjectDetailState = function() {
  if (projectsState.detailUnsubscribe) {
    projectsState.detailUnsubscribe();
    projectsState.detailUnsubscribe = null;
  }

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

  if (projectsState.activityUnsubscribe) {
    projectsState.activityUnsubscribe();
    projectsState.activityUnsubscribe = null;
  }

  projectsState.detailProject = null;
  projectsState.detailComments = [];
  projectsState.detailFiles = [];
  projectsState.detailTasks = [];
  projectsState.detailActivity = [];
};

export const briefingsState = {
  briefings:   [],
  unsubscribe: null,
  unsubscribeNotifier: null,
  hasUnread: false
};

export const projectsState = {
  projects:           [],
  unsubscribe:        null,
  activeProjectId:    null,
  detailUnsubscribe:  null,
  commentsUnsubscribe: null,
  filesUnsubscribe:   null,
  sidebarUnsubscribe: null,
  editingProjectId:   null,
  detailProject:      null,
  detailComments:     [],
  detailFiles:        [],
  detailTasks:        [],
  tasksUnsubscribe:   null,
  taskFilter:         'all',
  detailActivity:     [],
  activityUnsubscribe: null
};

export const resourcesState = {
  resources:      [],
  unsubscribe:    null,
  filter:         'all',
  searchQuery:    '',
  savedResources: []
};

export const resetResourcesState = function() {
  if (resourcesState.unsubscribe) {
    resourcesState.unsubscribe();
    resourcesState.unsubscribe = null;
  }
  resourcesState.resources = [];
  resourcesState.filter = 'all';
};

export const notificationsState = {
  notifications: [],
  unsubscribe:   null,
  unreadCount:   0
};

export const pickerState = {
  context: 'feed',
  projectId: null
};
