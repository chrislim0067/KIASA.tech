/**
 * The job board gate — the second one.
 *
 * `lib/auth/access.ts` decides whether somebody may use KIASA at all.  This
 * decides whether they may read the shared job board, and the two are
 * deliberately independent: approving a signup says "you may use the product",
 * not "you may read every posting the extension has collected".
 *
 * The rules, and why:
 *
 *   * ABSENCE MEANS {@link DEFAULT_JOB_BOARD_ACCESS} — no access. The third
 *     table in this schema to follow that rule, and for the third time it is
 *     the only safe direction. A read that fails degrades to "no board" rather
 *     than to "board".
 *
 *   * A GRANT IS NOT A ROLE. An administrator holds every capability in
 *     `lib/auth/roles.ts`, including the one that writes this table — but a
 *     grant is a row about one person, not a privilege that comes with a title.
 *     The two are combined at the guard, not conflated here.
 *
 *   * Nothing here is read from the client. The row is read server-side under
 *     the candidate's own session on every request that depends on it.
 */

export const JOB_BOARD_STATUSES = ['granted', 'revoked'] as const;
export type JobBoardStatus = (typeof JOB_BOARD_STATUSES)[number];

/** What a user with no `job_board_access` row is treated as. */
export const DEFAULT_JOB_BOARD_ACCESS: JobBoardStatus = 'revoked';

export const isJobBoardStatus = (value: unknown): value is JobBoardStatus =>
  typeof value === 'string' && (JOB_BOARD_STATUSES as readonly string[]).includes(value);

/**
 * Whether this status may read the board.
 *
 * Defined once so the page, the nav and any future route handler agree. Only
 * `granted` passes; `revoked` and absence are both "no", they differ only in
 * whether a decision was ever recorded.
 */
export function canSeeJobBoard(status: JobBoardStatus): boolean {
  return status === 'granted';
}

/** Where the shared board lives. Not `/jobs` — that is the candidate's own list. */
export const JOB_BOARD_ROUTE = '/job-board';

/**
 * Copy for the locked state.
 *
 * Shown rather than a 404. Pretending the page does not exist would leave
 * somebody who has been told about it with no way to understand why it is not
 * there, and the board's existence is not the secret — its contents are.
 */
export const JOB_BOARD_LOCKED = Object.freeze({
  title: 'You do not have access to the job board',
  body:
    'Your KIASA account is approved, but the job board is a separate permission ' +
    'and it has not been granted yet. Ask a KIASA administrator if you need it.',
});
