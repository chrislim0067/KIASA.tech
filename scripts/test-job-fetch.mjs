/**
 * SSRF protection and fetch limits.
 *
 *   node scripts/test-job-fetch.mjs
 *
 * NOTHING here reaches the public internet. Every request goes through an
 * injected fixture transport that records what was asked for, so the tests can
 * assert not only that a request was refused but that NO CONNECTION WAS
 * ATTEMPTED where the guard is supposed to fire before dialling.
 *
 * The case that matters most is the last one in section 3: a public host that
 * redirects to a private address. Following redirects automatically would check
 * only the URL the user supplied, so that hop has to be re-checked explicitly.
 *
 * Exits non-zero on any failure.
 */
import { jobs } from './support/load-profile-layer.mjs';

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Records every URL a fetcher tried to open. */
function recordingTransport(handler) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return { transport, calls };
}

const html = (body, headers = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });

/** robots.txt requests are answered permissively unless a case overrides it. */
const withRobots = (handler) => async (url, init) => {
  if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow:\n', { status: 200 });
  return handler(url, init);
};

/**
 * Fixture DNS. Injected so the address policy is exercised without a single
 * real lookup — the suite must behave identically on a machine with no network.
 * `public.example.com` maps to a public address; anything else is unresolvable.
 */
const fixtureResolver = async (hostname) => {
  const table = {
    'public.example.com': [{ address: '93.184.216.34' }],
    'other.example.com': [{ address: '93.184.216.35' }],
    // A host that resolves to BOTH a public and a private address must be
    // refused: which one gets used is not ours to control.
    'split.example.com': [{ address: '93.184.216.36' }, { address: '10.0.0.7' }],
    'private.example.com': [{ address: '10.1.2.3' }],
  };
  const found = table[hostname];
  if (!found) throw new Error(`ENOTFOUND ${hostname}`);
  return found;
};
const safeFetcher = (transport) =>
  jobs.createSafeFetcher({ transport, resolver: fixtureResolver, minHostIntervalMs: 0 });

/* ------------------------------------------- 1. address classification */

section('1. Address classification (pure, no I/O)');
{
  const blocked = [
    ['IPv4 loopback', '127.0.0.1'], ['IPv4 loopback range', '127.10.20.30'],
    ['this-network', '0.0.0.0'],
    ['RFC1918 10/8', '10.1.2.3'], ['RFC1918 172.16/12', '172.16.0.1'],
    ['RFC1918 172.31/12', '172.31.255.254'], ['RFC1918 192.168/16', '192.168.1.1'],
    ['link-local', '169.254.1.1'], ['cloud metadata', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'], ['benchmarking', '198.18.0.1'],
    ['TEST-NET-3', '203.0.113.10'], ['multicast', '224.0.0.1'], ['broadcast', '255.255.255.255'],
    ['IPv6 loopback', '::1'], ['IPv6 unspecified', '::'],
    ['IPv6 unique-local fc00::/7', 'fd00::1'], ['IPv6 link-local', 'fe80::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv4-mapped private', '::ffff:10.0.0.1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['not an IP at all', 'definitely-not-an-ip'],
  ];
  for (const [label, address] of blocked) {
    check(`blocks ${label} (${address})`, jobs.isBlockedAddress(address) === true);
  }
  const allowed = [
    ['public IPv4', '8.8.8.8'], ['public IPv4', '93.184.216.34'],
    ['public IPv6', '2606:4700:4700::1111'],
  ];
  for (const [label, address] of allowed) {
    check(`allows ${label} (${address})`, jobs.isBlockedAddress(address) === false);
  }
}

section('2. Hostname resolution policy');
{
  // Every case uses the fixture resolver, so no real DNS query is made.
  for (const host of ['localhost', 'LOCALHOST', 'metadata', 'nodots']) {
    const verdict = await jobs.checkHost(host, fixtureResolver);
    check(`refuses bare host "${host}"`, verdict.allowed === false, verdict.reason);
  }
  for (const literal of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', 'fd00::1']) {
    const verdict = await jobs.checkHost(literal, fixtureResolver);
    check(`refuses IP literal ${literal}`, verdict.allowed === false, verdict.reason);
  }
  {
    // A hostname that cannot resolve is refused, not optimistically allowed.
    const verdict = await jobs.checkHost('this-host-does-not-exist.invalid', fixtureResolver);
    check('refuses an unresolvable host', verdict.allowed === false, verdict.reason);
  }
  {
    const verdict = await jobs.checkHost('private.example.com', fixtureResolver);
    check('refuses a public NAME resolving to a private address',
      verdict.allowed === false && verdict.reason === 'blocked_address', verdict.reason);
  }
  {
    // Resolving to both a public and a private address must be refused: which
    // address the connection actually uses is not ours to control.
    const verdict = await jobs.checkHost('split.example.com', fixtureResolver);
    check('refuses a host resolving to BOTH public and private addresses',
      verdict.allowed === false && verdict.reason === 'blocked_address', verdict.reason);
  }
  {
    const verdict = await jobs.checkHost('8.8.8.8', fixtureResolver);
    check('allows a public IP literal', verdict.allowed === true);
  }
  {
    const verdict = await jobs.checkHost('public.example.com', fixtureResolver);
    check('allows a public name resolving to a public address', verdict.allowed === true);
  }
}

/* ------------------------------------------------- 3. the fetcher itself */

section('3. The fetcher refuses unsafe targets before dialling');
{
  const cases = [
    ['http://127.0.0.1/job', 'loopback'],
    ['http://localhost:3000/job', 'localhost'],
    ['http://[::1]/job', 'IPv6 loopback'],
    ['http://10.0.0.5/job', 'RFC1918 10/8'],
    ['http://172.16.4.4/job', 'RFC1918 172.16/12'],
    ['http://192.168.0.9/job', 'RFC1918 192.168/16'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://[fd00::1]/job', 'IPv6 unique-local'],
    ['ftp://example.com/job', 'non-http scheme'],
    ['file:///etc/passwd', 'file scheme'],
  ];
  for (const [url, label] of cases) {
    const { transport, calls } = recordingTransport(async () => html('<html></html>'));
    const fetcher = safeFetcher(transport);
    const attempt = await fetcher.fetch(url, { respectRobots: false });
    check(`refuses ${label}`, attempt.outcome === 'refused_by_policy',
      `${attempt.outcome}/${attempt.reason}`);
    check(`  no connection attempted for ${label}`, calls.length === 0, `${calls.length} call(s)`);
  }
}

section('4. A public host that REDIRECTS to a private address is refused');
{
  // The guard must re-run on every hop. The first host is public and IS dialled;
  // the redirect target is private and must never be.
  const { transport, calls } = recordingTransport(withRobots(async (url) => {
    if (url.startsWith('https://public.example.com')) {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    return html('<html>should never be reached</html>');
  }));
  const fetcher = safeFetcher(transport);
  const attempt = await fetcher.fetch('https://public.example.com/job', { respectRobots: false });

  check('the redirect to a private address is refused', attempt.outcome === 'refused_by_policy',
    `${attempt.outcome}/${attempt.reason}`);
  check('  the refusal names the address policy', attempt.reason === 'blocked_address', String(attempt.reason));
  const dialledMetadata = calls.some((c) => c.includes('169.254.169.254'));
  check('  the metadata endpoint was never dialled', dialledMetadata === false,
    dialledMetadata ? calls.join(' ') : 'not contacted');
  check('  the public first hop WAS dialled (proving the test is live)',
    calls.some((c) => c.startsWith('https://public.example.com')), `${calls.length} call(s)`);

  // Same again for a redirect to a scheme we do not allow.
  const second = recordingTransport(withRobots(async () =>
    new Response(null, { status: 301, headers: { location: 'file:///etc/passwd' } })));
  const f2 = safeFetcher(second.transport);
  const a2 = await f2.fetch('https://public.example.com/job', { respectRobots: false });
  check('a redirect to a non-http scheme is refused', a2.outcome === 'refused_by_policy',
    `${a2.outcome}/${a2.reason}`);
}

section('5. Fetch limits, each mapping to its own category');
{
  // Redirect cap.
  {
    const { transport } = recordingTransport(withRobots(async (url) => {
      const n = Number(/n=(\d+)/.exec(url)?.[1] ?? '0');
      return new Response(null, { status: 302, headers: { location: `https://public.example.com/job?n=${n + 1}` } });
    }));
    const fetcher = safeFetcher(transport);
    const attempt = await fetcher.fetch('https://public.example.com/job?n=0', { respectRobots: false, maxRedirects: 3 });
    check('the redirect cap is enforced', attempt.outcome === 'refused_by_policy' && attempt.reason === 'too_many_redirects',
      `${attempt.outcome}/${attempt.reason}`);
  }
  // Declared content-length over the cap: refused before reading a body.
  {
    const { transport } = recordingTransport(withRobots(async () =>
      new Response('x', { status: 200, headers: { 'content-type': 'text/html', 'content-length': '99999999' } })));
    const fetcher = safeFetcher(transport);
    const attempt = await fetcher.fetch('https://public.example.com/job', { respectRobots: false, maxBytes: 1000 });
    check('an oversize declared length is refused', attempt.outcome === 'too_large' && attempt.reason === 'content_length',
      `${attempt.outcome}/${attempt.reason}`);
  }
  // A LYING content-length: the stream must still be capped.
  {
    const big = 'y'.repeat(50_000);
    const { transport } = recordingTransport(withRobots(async () =>
      new Response(big, { status: 200, headers: { 'content-type': 'text/html', 'content-length': '10' } })));
    const fetcher = safeFetcher(transport);
    const attempt = await fetcher.fetch('https://public.example.com/job', { respectRobots: false, maxBytes: 1000 });
    check('an understated content-length is still capped while streaming',
      attempt.outcome === 'too_large' && attempt.reason === 'stream_exceeded_limit',
      `${attempt.outcome}/${attempt.reason}`);
    check('  and no oversized body is returned', attempt.body === null);
  }
  // Unsupported content type.
  {
    const { transport } = recordingTransport(withRobots(async () =>
      new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } })));
    const fetcher = safeFetcher(transport);
    const attempt = await fetcher.fetch('https://public.example.com/job', { respectRobots: false });
    check('an unsupported content type is refused',
      attempt.outcome === 'unsupported_content_type' && attempt.reason === 'application/pdf',
      `${attempt.outcome}/${attempt.reason}`);
    check('  and its body is not stored', attempt.body === null);
  }
  // Timeout.
  {
    const { transport } = recordingTransport(withRobots(async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })));
    const fetcher = safeFetcher(transport);
    const attempt = await fetcher.fetch('https://public.example.com/job', { respectRobots: false, timeoutMs: 60 });
    check('a timeout is honoured and categorised', attempt.outcome === 'timeout', `${attempt.outcome}`);
  }
  // Transport failure.
  {
    const { transport } = recordingTransport(withRobots(async () => { throw new Error('ECONNREFUSED'); }));
    const fetcher = safeFetcher(transport);
    const attempt = await fetcher.fetch('https://public.example.com/job', { respectRobots: false });
    check('a transport failure is categorised', attempt.outcome === 'transport', `${attempt.outcome}`);
  }
  // HTTP status mapping.
  for (const [status, expected] of [[404, 'gone'], [410, 'gone'], [401, 'login_required'],
    [403, 'login_required'], [429, 'rate_limited'], [451, 'access_blocked'], [500, 'transport']]) {
    const { transport } = recordingTransport(withRobots(async () => new Response('', { status })));
    const fetcher = safeFetcher(transport);
    const attempt = await fetcher.fetch('https://public.example.com/job', { respectRobots: false });
    check(`HTTP ${status} maps to ${expected}`, attempt.outcome === expected, attempt.outcome);
  }
}

section('6. A successful fetch stores faithful evidence');
{
  const body = '<html><head><title>Engineer</title></head><body>Hi</body></html>';
  const { transport, calls } = recordingTransport(withRobots(async () => html(body)));
  const fetcher = safeFetcher(transport);
  const attempt = await fetcher.fetch('https://public.example.com/job', { respectRobots: false });
  check('outcome is ok', attempt.outcome === 'ok', attempt.outcome);
  check('the body is returned byte-for-byte', attempt.body === body);
  check('byte size is measured, not guessed', attempt.byteSize === Buffer.byteLength(body, 'utf8'),
    `${attempt.byteSize}`);
  check('a sha-256 content hash is recorded', /^[0-9a-f]{64}$/.test(attempt.contentHash ?? ''), String(attempt.contentHash));
  check('the final URL is recorded', attempt.finalUrl === 'https://public.example.com/job', String(attempt.finalUrl));
  check('exactly one request was made', calls.length === 1, `${calls.length}`);

  // No credentials or cookies may leave for a third-party host.
  let sentHeaders = null;
  const probe = recordingTransport(withRobots(async (_url, init) => { sentHeaders = init?.headers ?? {}; return html(body); }));
  const f2 = safeFetcher(probe.transport);
  await f2.fetch('https://public.example.com/job', { respectRobots: false });
  const headerNames = Object.keys(sentHeaders ?? {}).map((h) => h.toLowerCase());
  check('no cookie header is sent', !headerNames.includes('cookie'), headerNames.join(','));
  check('no authorization header is sent', !headerNames.includes('authorization'));
  check('no supabase header is sent', !headerNames.some((h) => h.includes('apikey') || h.includes('supabase')));
  check('an identifying user-agent IS sent', headerNames.includes('user-agent'));
}

section('7. robots.txt is respected, and a refusal is a first-class outcome');
{
  const disallowing = withRobots(async () => html('<html></html>'));
  const robotsTxt = 'User-agent: *\nDisallow: /private\n';
  const { transport } = recordingTransport(async (url, init) => {
    if (url.endsWith('/robots.txt')) return new Response(robotsTxt, { status: 200 });
    return disallowing(url, init);
  });
  const fetcher = safeFetcher(transport);

  const blocked = await fetcher.fetch('https://public.example.com/private/job', { respectRobots: true });
  check('a disallowed path is refused', blocked.outcome === 'refused_by_policy' && blocked.reason === 'robots_disallowed',
    `${blocked.outcome}/${blocked.reason}`);

  const permitted = await fetcher.fetch('https://public.example.com/public/job', { respectRobots: true });
  check('a permitted path proceeds', permitted.outcome === 'ok', `${permitted.outcome}/${permitted.reason}`);

  // Pure robots evaluation.
  const cases = [
    ['disallow all', 'User-agent: *\nDisallow: /', '/anything', false],
    ['empty disallow means allow', 'User-agent: *\nDisallow:', '/anything', true],
    ['longest match wins (allow)', 'User-agent: *\nDisallow: /a\nAllow: /a/b', '/a/b/c', true],
    ['longest match wins (disallow)', 'User-agent: *\nDisallow: /a/b\nAllow: /a', '/a/b/c', false],
    ['no rules at all', '', '/anything', true],
    ['unparseable content is treated as no rules', 'this is not robots syntax', '/anything', true],
    ['a group for another agent does not apply', 'User-agent: EvilBot\nDisallow: /', '/anything', true],
  ];
  for (const [label, txt, path, expected] of cases) {
    check(`robots: ${label}`, jobs.isAllowedByRobots(txt, path, 'KIASA-JobIntake/1.0') === expected);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} FETCH AND SSRF CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
