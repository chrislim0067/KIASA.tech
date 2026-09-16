/**
 * A stand-in for `@supabase/supabase-js`, for the job board tests.
 *
 * TEST-ONLY. `scripts/test-admin-jobs.mjs` resolves the real package to this
 * module before it imports `lib/jobboard/queries.ts`, so the query functions
 * under test run for real — their limits, their ordering, their coercion, their
 * fail-soft branches — against rows this file hands back.
 *
 * WHY A STUB AND NOT A DATABASE. The job board lives in a SECOND Supabase
 * project belonging to another repository. There is no local stack for it, no
 * migration in this tree to create `saved_jobs`, and no fixture data. What the
 * tests need to prove is not that Postgres works; it is that a row of any shape
 * — from a schema this repository does not own and cannot pin — becomes a
 * predictable, safe projection. That is a question about `toSummary`, and rows
 * from a stub ask it more sharply than real ones, because a stub can return the
 * malformed row a healthy database never would.
 *
 * The builder is a thenable because PostgREST's is: `await client.from(…)
 * .select(…).limit(…).order(…)` runs the query by awaiting the builder itself.
 * A stub that returned a plain object would never execute.
 */

/** What the next query returns. Replaced wholesale by {@link reset}. */
let script = {
  /** Rows the `saved_jobs` select resolves with. */
  rows: [],
  /** When set, the select fails with this message instead. */
  error: null,
  /** Accounts `auth.admin.listUsers()` resolves with. */
  users: [],
  /** When set, the directory lookup fails with this message. */
  usersError: null,
  /** 'createClient' | 'listUsers' — where to throw rather than return. */
  throwAt: null,
};

/** What the module under test actually asked for. Inspected after each case. */
export const seen = {
  /** One entry per `createClient()` call: { url, key, options }. */
  clients: [],
  /** One entry per `.from()` chain, recording everything it was told. */
  queries: [],
  /** How many times the auth directory was read. */
  listUsers: 0,
};

export function reset(next = {}) {
  script = {
    rows: [],
    error: null,
    users: [],
    usersError: null,
    throwAt: null,
    ...next,
  };
  seen.clients.length = 0;
  seen.queries.length = 0;
  seen.listUsers = 0;
}

function builder(table) {
  const query = { table, columns: null, limit: null, order: null, eq: [], single: false };
  seen.queries.push(query);

  const run = () =>
    script.error
      ? { data: null, error: { message: script.error } }
      : { data: script.rows, error: null };

  const api = {
    select(columns) {
      query.columns = columns;
      return api;
    },
    limit(count) {
      query.limit = count;
      return api;
    },
    order(column, options = {}) {
      query.order = { column, ...options };
      return api;
    },
    eq(column, value) {
      // Recorded as a VALUE, which is the whole point: PostgREST binds it
      // rather than interpolating it, so an id taken from a URL cannot become
      // part of the query. The test asserts what arrived here, untouched.
      query.eq.push([column, value]);
      return api;
    },
    async maybeSingle() {
      query.single = true;
      const { data, error } = run();
      return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
    },
    /** PostgREST builders are thenables; awaiting one is how it runs. */
    then(onFulfilled, onRejected) {
      return Promise.resolve(run()).then(onFulfilled, onRejected);
    },
  };

  return api;
}

export function createClient(url, key, options) {
  seen.clients.push({ url, key, options });
  if (script.throwAt === 'createClient') throw new Error('stub: the project was unreachable');

  return {
    from: (table) => builder(table),
    auth: {
      admin: {
        async listUsers(args) {
          seen.listUsers += 1;
          if (script.throwAt === 'listUsers') throw new Error('stub: the directory was unreachable');
          if (script.usersError) return { data: null, error: { message: script.usersError }, args };
          return { data: { users: script.users }, error: null };
        },
      },
    },
    /* The realtime path is not exercised here; reaching it is a test bug. */
    channel() {
      throw new Error('stub: channel() is not part of the query path');
    },
    async removeChannel() {},
  };
}
