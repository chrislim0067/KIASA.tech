/**
 * Constants shared by the browser and the server.
 *
 * Deliberately free of `server-only` and of any Node import: the upload
 * component runs in the browser and needs the same bucket name and the same
 * path shape the server validates against. Two copies of that rule would be one
 * copy too many — a mismatch would show up as a storage policy denial with no
 * obvious cause.
 */

export const RESUME_BUCKET = 'resumes';

export const RESUME_ROUTE = '/profile/resume';

/** The only accepted upload type. Text is extracted from it server-side. */
export const RESUME_MIME = 'application/pdf';

/** Matches the `resumes` bucket's own `file_size_limit`. */
export const RESUME_MAX_BYTES = 10 * 1024 * 1024;

/**
 * `<user id>/<object id>.pdf`.
 *
 * The first segment IS the owner, which is what every storage policy on the
 * bucket compares against. Because the server rebuilds this from the
 * authenticated user's id rather than accepting a path from the form, a client
 * cannot name a file outside its own folder even in principle.
 */
export function storagePathFor(userId: string, objectId: string): string {
  return `${userId}/${objectId}.pdf`;
}
