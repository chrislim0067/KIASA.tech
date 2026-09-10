/**
 * Profile route constants, shared by the server and the browser.
 *
 * Deliberately free of `server-only` and of any import: the drafting panel runs
 * in the browser and links to the same pages the server renders. Two copies of
 * a path would be one copy too many — a mismatch shows up as a dead link rather
 * than as a build error.
 */

export const PROFILE_ROUTE = '/profile';

/** Where a candidate reviews what local Claude proposed for their profile. */
export const PROFILE_DRAFT_ROUTE = '/profile/draft';

/** Where a candidate pairs and watches the worker on their own computer. */
export const WORKER_ROUTE = '/profile/worker';
