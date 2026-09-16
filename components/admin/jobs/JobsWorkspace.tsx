'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { JOB_STATUSES, JOB_STATUS_LABELS, type JobStatus, type JobSummary } from '@/lib/jobboard/types';
import JobRow from './JobRow';
import JobCard from './JobCard';
import JobsLive from './JobsLive';
import { PAGE_SIZES, setStoredPageSize, usePageSize } from './use-page-size';

type Sort = 'recent' | 'salary' | 'company';

/**
 * How many cards a board column renders.
 *
 * The board is an overview, not a working list — the count in the header is the
 * number that matters. Rendering every one of several hundred cards costs real
 * layout time on every filter keystroke, so the tail is summarised and the list
 * view is where you go to work through it.
 */
const BOARD_COLUMN_LIMIT = 40;

/**
 * The administrator's view of every saved job.
 *
 * Two views over one list. The LIST is the working surface — dense, filterable,
 * sortable, built for "what is actually coming in". The BOARD is for seeing the
 * shape of the pipeline across all candidates at a glance.
 *
 * Read-only throughout. The candidate-facing board this is modelled on carries
 * optimistic status updates, drag-and-drop between columns and bulk delete;
 * none of that is here, because none of it is something an administrator should
 * do to someone else's pipeline without a decision nobody has made yet. What is
 * here is every way of LOOKING at the data.
 *
 * Filtering and paging are client-side because the whole set is already in
 * memory — the server component fetched it. What paging buys is not fetching,
 * it is the DOM: at a few hundred rows the browser was laying out every card,
 * each with a logo, an SVG ring and two dozen nodes, on every keystroke.
 */
export default function JobsWorkspace({
  jobs,
  truncated,
}: {
  jobs: readonly JobSummary[];
  truncated: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<'list' | 'board'>('list');
  const [statusFilter, setStatusFilter] = useState<'all' | JobStatus>('all');
  const [query, setQuery] = useState('');
  const [workplace, setWorkplace] = useState<'any' | 'remote' | 'hybrid' | 'onsite'>('any');
  const [sort, setSort] = useState<Sort>('recent');
  const [page, setPage] = useState(0);

  const pageSize = usePageSize();

  /**
   * Every filter change goes through here, and every one resets to page one.
   *
   * Explicit rather than an effect watching the filter values. Narrowing a
   * hundred rows to three while sitting on page four shows an empty list that
   * looks like "no results", so the reset is part of what changing a filter
   * MEANS — not a correction applied after the fact. Doing it in an effect
   * would also render the wrong page once before fixing it.
   */
  function applyFilter(change: () => void) {
    change();
    setPage(0);
  }

  /**
   * HOW MANY people are on the board, never WHICH.
   *
   * Counted over `user_id`, which is an opaque identifier from another
   * project's `auth.users` — it says two accounts are represented without
   * saying whose. The addresses that used to fill an owner filter here are gone
   * along with the column; see the note at the bottom of lib/jobboard/types.ts.
   */
  const ownerCount = useMemo(
    () => new Set(jobs.map((job) => job.user_id)).size,
    [jobs]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const filtered = jobs.filter((job) => {
      if (statusFilter !== 'all' && job.status !== statusFilter) return false;
      if (workplace !== 'any' && job.workplace_type !== workplace) return false;
      if (!needle) return true;

      return [job.title, job.company, job.location, job.domain, ...job.skills]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(needle));
    });

    return [...filtered].sort((a, b) => {
      if (sort === 'salary') {
        return (b.salary_max ?? b.salary_min ?? 0) - (a.salary_max ?? a.salary_min ?? 0);
      }
      if (sort === 'company') return (a.company ?? '').localeCompare(b.company ?? '');
      return new Date(b.saved_at).getTime() - new Date(a.saved_at).getTime();
    });
  }, [jobs, query, statusFilter, workplace, sort]);

  const byStatus = useMemo(() => {
    const grouped = new Map<JobStatus, JobSummary[]>(JOB_STATUSES.map((status) => [status, []]));
    for (const job of visible) grouped.get(job.status)?.push(job);
    return grouped;
  }, [visible]);

  /**
   * The slice the list actually renders.
   *
   * Only the list pages. The board is a pipeline overview and a column reading
   * "10 of 47" would misrepresent the shape of the pipeline, which is the one
   * thing that view exists to convey.
   */
  const paged = useMemo(() => {
    const start = page * pageSize;
    return visible.slice(start, start + pageSize);
  }, [visible, page, pageSize]);

  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, pages - 1);

  const filtersActive =
    query.length > 0 || workplace !== 'any' || statusFilter !== 'all';

  function clearFilters() {
    applyFilter(() => {
      setQuery('');
      setWorkplace('any');
      setStatusFilter('all');
    });
  }

  const open = (id: string) => router.push(`/admin/jobs/${id}`);

  return (
    <div className="kjobs">
      <div className="kjobs__head">
        <p className="kjobs__count">
          <strong>{visible.length}</strong> of {jobs.length} saved
          {ownerCount > 0 ? ` · ${ownerCount} ${ownerCount === 1 ? 'account' : 'accounts'}` : ''}
          <JobsLive />
        </p>

        <div className="kjobs__viewToggle" role="group" aria-label="View">
          <button
            type="button"
            className={`kjobs__viewBtn${view === 'list' ? ' kjobs__viewBtn--on' : ''}`}
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
          >
            List
          </button>
          <button
            type="button"
            className={`kjobs__viewBtn${view === 'board' ? ' kjobs__viewBtn--on' : ''}`}
            onClick={() => setView('board')}
            aria-pressed={view === 'board'}
          >
            Board
          </button>
        </div>
      </div>

      {truncated ? (
        <p className="kadmin__notice kadmin__notice--warn">
          Showing the most recent 500 postings. Older ones exist but are not loaded — narrow by
          status once paging across the whole table is needed.
        </p>
      ) : null}

      <div className="kjobs__filters">
        <input
          className="kadmin__input kjobs__search"
          type="search"
          placeholder="Search title, company, location or skill"
          value={query}
          onChange={(event) => applyFilter(() => setQuery(event.target.value))}
          aria-label="Search saved jobs"
        />

        <select
          className="kadmin__select"
          value={statusFilter}
          onChange={(event) => applyFilter(() => setStatusFilter(event.target.value as 'all' | JobStatus))}
          aria-label="Filter by status"
        >
          <option value="all">Any status</option>
          {JOB_STATUSES.map((status) => (
            <option key={status} value={status}>
              {JOB_STATUS_LABELS[status]}
            </option>
          ))}
        </select>

        <select
          className="kadmin__select"
          value={workplace}
          onChange={(event) => applyFilter(() => setWorkplace(event.target.value as typeof workplace))}
          aria-label="Filter by workplace"
        >
          <option value="any">Anywhere</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">Onsite</option>
        </select>

        <select
          className="kadmin__select"
          value={sort}
          onChange={(event) => applyFilter(() => setSort(event.target.value as Sort))}
          aria-label="Sort"
        >
          <option value="recent">Newest first</option>
          <option value="salary">Highest salary</option>
          <option value="company">Company A–Z</option>
          </select>

        {filtersActive ? (
          <button
            type="button"
            className="kadmin__button kadmin__button--ghost kadmin__button--small"
            onClick={clearFilters}
          >
            Clear
          </button>
        ) : null}
      </div>

      {jobs.length === 0 ? (
        <EmptyBoard />
      ) : visible.length === 0 ? (
        <div className="kadmin__empty">
          <p>Nothing saved fits those filters.</p>
          <button type="button" className="kadmin__button kadmin__button--small" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : view === 'list' ? (
        <>
          <div className="kjobs__rows">
            {paged.map((job) => (
              <JobRow key={job.id} job={job} onOpen={() => open(job.id)} />
            ))}
          </div>

          <div className="kjobs__pager">
            <span className="kjobs__pagerCount">
              {current * pageSize + 1}–{Math.min((current + 1) * pageSize, visible.length)} of{' '}
              {visible.length}
            </span>

            <span className="kjobs__pagerLinks">
              <button
                type="button"
                className="kadmin__button kadmin__button--small kadmin__button--ghost"
                disabled={current === 0}
                onClick={() => {
                  setPage(current - 1);
                  // Paging without this leaves the reader at the bottom of a
                  // list that has entirely changed above them.
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                Previous
              </button>
              <button
                type="button"
                className="kadmin__button kadmin__button--small kadmin__button--ghost"
                disabled={current >= pages - 1}
                onClick={() => {
                  setPage(current + 1);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                Next
              </button>
            </span>

            <select
              className="kadmin__select"
              value={pageSize}
              onChange={(event) => applyFilter(() => setStoredPageSize(Number(event.target.value)))}
              aria-label="Rows per page"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} per page
                </option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <div className="kjobs__board">
          {JOB_STATUSES.map((status) => {
            const columnJobs = byStatus.get(status) ?? [];
            return (
              <section key={status} className="kjobs__column">
                <header className="kjobs__columnHead">
                  <span
                    className={`kjobs__columnDot kjobs__columnDot--${status}`}
                    aria-hidden="true"
                  />
                  <h2 className="kjobs__columnTitle">{JOB_STATUS_LABELS[status]}</h2>
                  <span className="kjobs__columnCount">{columnJobs.length}</span>
                </header>

                <div className="kjobs__columnBody">
                  {columnJobs.length === 0 ? (
                    <p className="kjobs__columnEmpty">Nothing here</p>
                  ) : (
                    columnJobs
                      .slice(0, BOARD_COLUMN_LIMIT)
                      .map((job) => <JobCard key={job.id} job={job} onOpen={() => open(job.id)} />)
                  )}

                  {columnJobs.length > BOARD_COLUMN_LIMIT ? (
                    <p className="kjobs__columnMore">
                      +{columnJobs.length - BOARD_COLUMN_LIMIT} more — switch to List to see them
                    </p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyBoard() {
  return (
    <div className="kadmin__empty">
      <p>No postings have been saved yet.</p>
      <p className="kjobs__emptyNote">
        Rows appear here the moment the browser extension saves one — this page is subscribed to the
        table, so nothing needs refreshing. If saves are reported as successful but nothing shows
        up, check that <code>JOBBOARD_SUPABASE_URL</code> points at the same project the extension
        writes to.
      </p>
    </div>
  );
}
