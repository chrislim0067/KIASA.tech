'use client';

import { useMemo, useState } from 'react';

import type { JobOpportunity } from '@/lib/jobboard/types';
import OpportunityRow from './OpportunityRow';

type Sort = 'recent' | 'salary' | 'company';

/** How many rows one page renders. */
const PAGE_SIZE = 25;

/**
 * The candidate's view of the shared board.
 *
 * A LEANER SURFACE THAN THE ADMINISTRATOR'S, and every omission is deliberate
 * rather than unfinished:
 *
 *   * No status filter and no pipeline view. Those describe whose application
 *     is where, which is exactly what this audience does not see.
 *   * No owner filter. There is no owner on the type.
 *   * No live stream. The administrator board holds one Server-Sent Events
 *     connection per viewer, which is affordable for a handful of
 *     administrators and is not for every permitted candidate — each open
 *     stream pins a server invocation for its lifetime. A candidate browsing
 *     opportunities does not need sub-second freshness; the page is
 *     `force-dynamic`, so every visit and every navigation back is current.
 *
 * Filtering and paging are client-side because the whole set is already in
 * memory — the server component fetched it. What paging buys is the DOM, not
 * the fetch: several hundred rows, each with a logo and a dozen nodes, laid out
 * again on every keystroke is what made this necessary on the admin board.
 */
export default function JobBoardWorkspace({
  jobs,
  truncated,
}: {
  jobs: readonly JobOpportunity[];
  truncated: boolean;
}) {
  const [query, setQuery] = useState('');
  const [workplace, setWorkplace] = useState<'any' | 'remote' | 'hybrid' | 'onsite'>('any');
  const [sort, setSort] = useState<Sort>('recent');
  const [page, setPage] = useState(0);

  /**
   * Every filter change resets to page one, explicitly rather than in an
   * effect. Narrowing three hundred rows to four while sitting on page six
   * shows an empty list that reads as "no results", so the reset is part of
   * what changing a filter MEANS — not a correction applied afterwards.
   */
  function applyFilter(change: () => void) {
    change();
    setPage(0);
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const filtered = jobs.filter((job) => {
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
  }, [jobs, query, workplace, sort]);

  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const paged = useMemo(
    () => visible.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE),
    [visible, current]
  );

  const filtersActive = query.length > 0 || workplace !== 'any';

  function clearFilters() {
    applyFilter(() => {
      setQuery('');
      setWorkplace('any');
    });
  }

  return (
    <div className="kjb">
      <div className="kjb__head">
        <p className="kjb__count">
          <strong>{visible.length}</strong> of {jobs.length} opportunities
        </p>
      </div>

      {truncated ? (
        <p className="kjb__notice">
          Showing the most recent 500 postings. Older ones exist but are not loaded.
        </p>
      ) : null}

      <div className="kjb__filters">
        <input
          className="kjb__input kjb__search"
          type="search"
          placeholder="Search title, company, location or skill"
          value={query}
          onChange={(event) => applyFilter(() => setQuery(event.target.value))}
          aria-label="Search opportunities"
        />

        <select
          className="kjb__select"
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
          className="kjb__select"
          value={sort}
          onChange={(event) => applyFilter(() => setSort(event.target.value as Sort))}
          aria-label="Sort"
        >
          <option value="recent">Newest first</option>
          <option value="salary">Highest salary</option>
          <option value="company">Company A–Z</option>
        </select>

        {filtersActive ? (
          <button type="button" className="kjb__button" onClick={clearFilters}>
            Clear
          </button>
        ) : null}
      </div>

      {jobs.length === 0 ? (
        <div className="kjb__empty">
          <p>There are no postings on the board yet.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="kjb__empty">
          <p>Nothing here fits those filters.</p>
          <button type="button" className="kjb__button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div className="kjb__rows">
            {paged.map((job) => (
              <OpportunityRow key={job.id} job={job} />
            ))}
          </div>

          <div className="kjb__pager">
            <span className="kjb__pagerCount">
              {current * PAGE_SIZE + 1}–{Math.min((current + 1) * PAGE_SIZE, visible.length)} of{' '}
              {visible.length}
            </span>

            <span className="kjb__pagerLinks">
              <button
                type="button"
                className="kjb__button"
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
                className="kjb__button"
                disabled={current >= pages - 1}
                onClick={() => {
                  setPage(current + 1);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                Next
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
