import type { JobStatus } from '@/lib/jobs/state';

/**
 * What each job status means to the person who added the link.
 *
 * A CLOSED VOCABULARY, turned into sentences here and nowhere else. The status
 * column is CHECK-constrained to these eight, so the map is total and a status
 * that is not one of them renders as the neutral line rather than as itself —
 * a database value is not something to print at a candidate.
 *
 * Deliberately free of `server-only`: the list and the detail page both render
 * these, and neither needs anything but the strings.
 */
export const JOB_STATUS_COPY: Record<JobStatus, { label: string; note: string }> = {
  received: {
    label: 'Queued',
    note: 'Added. KIASA has not read the page yet.',
  },
  fetching: {
    label: 'Reading',
    note: 'KIASA is fetching the posting now.',
  },
  fetched: {
    label: 'Read',
    note: 'The page came back. The details have not been pulled out yet.',
  },
  fetch_failed: {
    label: 'Could not be read',
    note:
      'The page could not be fetched — it may need a sign-in, or the site may not allow ' +
      'automated reading. The original link still works.',
  },
  extracting: {
    label: 'Reading the details',
    note: 'KIASA is pulling the title, company and description out of the page.',
  },
  extracted: {
    label: 'Ready',
    note: 'The details below came from the posting itself.',
  },
  extraction_incomplete: {
    label: 'Partly read',
    note:
      'Some details could not be found on the page. What is missing is shown as blank ' +
      'rather than guessed.',
  },
  archived: {
    label: 'Archived',
    note: 'You put this one aside.',
  },
};

const NEUTRAL = {
  label: 'Unknown',
  note: 'KIASA cannot describe the state of this one.',
};

export function describeJobStatus(status: string): { label: string; note: string } {
  return JOB_STATUS_COPY[status as JobStatus] ?? NEUTRAL;
}
