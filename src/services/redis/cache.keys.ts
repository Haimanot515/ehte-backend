// src/services/redis/cache.keys.ts
// Cache status/metadata, never raw report/evidence bodies. Hash identifiers, never raw ones.

export const CacheKeys = {
  profile: (userId: string) => `ehte:user:${userId}:profile`,
  session: (userId: string) => `ehte:user:${userId}:session`,
  failedLoginAttempts: (identifier: string) =>
    `ehte:auth:failed-attempts:${identifier}`,
  passwordReset: (token: string) => `ehte:auth:pwd-reset:${token}`,

  reportStatus: (reportId: string) => `ehte:report:${reportId}:status`,
  myReports: (userId: string, page = 1) =>
    `ehte:user:${userId}:reports:${page}`,

  post: (postId: string) => `ehte:post:${postId}`,
  postList: (queryHash: string) => `ehte:post:list:${queryHash}`,
  myPosts: (userId: string, page = 1) => `ehte:user:${userId}:posts:${page}`,
  pendingPostsCount: () => 'ehte:posts:pending-count',

  missingPerson: (id: string) => `ehte:missing-person:${id}`,
  missingPersonList: (queryHash: string) =>
    `ehte:missing-person:list:${queryHash}`,
  approvedMissingPersons: (page = 1) => `ehte:missing-person:approved:${page}`,

  // Scoped per missing-person case: each case's submissions are cached and
  // invalidated independently of every other case's list.
  informationSubmissionList: (missingPersonId: string, queryHash: string) =>
    `ehte:information-submission:list:${missingPersonId}:${queryHash}`,

  victimProfile: (id: string) => `ehte:victim-profile:${id}`,
  victimProfileList: (queryHash: string) =>
    `ehte:victim-profile:list:${queryHash}`,
  approvedVictimProfiles: (page = 1) =>
    `ehte:victim-profile:approved:${page}`,

  notifications: (userId: string, page = 1) =>
    `ehte:user:${userId}:notifications:${page}`,
  unreadNotificationCount: (userId: string) =>
    `ehte:user:${userId}:notifications:unread-count`,

  incidentCategories: () => 'ehte:taxonomy:incident-categories',
  supportCategories: () => 'ehte:taxonomy:support-categories',

  adminDashboardStats: () => 'ehte:admin:dashboard-stats',

  patterns: {
    userAll: (userId: string) => `ehte:user:${userId}:*`,
    userReports: (userId: string) => `ehte:user:${userId}:reports:*`,
    userPosts: (userId: string) => `ehte:user:${userId}:posts:*`,
    userNotifications: (userId: string) =>
      `ehte:user:${userId}:notifications:*`,
    postLists: () => 'ehte:post:list:*',
    missingPersonLists: () => 'ehte:missing-person:list:*',
    approvedMissingPersons: () => 'ehte:missing-person:approved:*',
    informationSubmissionLists: (missingPersonId: string) =>
      `ehte:information-submission:list:${missingPersonId}:*`,
    victimProfileLists: () => 'ehte:victim-profile:list:*',
    approvedVictimProfiles: () => 'ehte:victim-profile:approved:*',
  },
};

export const TTL = {
  SESSION: 900,
  FAILED_LOGIN_ATTEMPTS: 900,
  PASSWORD_RESET: 600,

  REPORT_STATUS: 60,
  MY_REPORTS: 60,

  POST_DETAIL: 300,
  POST_LIST: 60,
  MY_POSTS: 60,
  PENDING_POSTS_COUNT: 30,

  MISSING_PERSON_DETAIL: 300,
  MISSING_PERSON_LIST: 120,
  APPROVED_MISSING_PERSONS: 120,

  INFORMATION_SUBMISSION_LIST: 120,

  VICTIM_PROFILE_DETAIL: 300,
  VICTIM_PROFILE_LIST: 120,
  APPROVED_VICTIM_PROFILES: 120,

  NOTIFICATIONS: 30,
  UNREAD_NOTIFICATION_COUNT: 15,

  TAXONOMY: 1800,

  ADMIN_DASHBOARD_STATS: 60,
} as const;