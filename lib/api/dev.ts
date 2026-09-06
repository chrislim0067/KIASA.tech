/**
 * Shared helpers for the four handlers that stand in for the PHP endpoints.
 *
 * The production site answers these from PHP (api/lead.php et al). These
 * reproduce the wire contract the front-end already depends on — the request
 * bodies and response shapes are taken from the shipped client code, not
 * invented — so no page script needed changing. Swap the bodies for real logic
 * (or proxy them) when the PHP side is available.
 */
export const PROXY = process.env.WT_API_PROXY === '1';
export const UPSTREAM = process.env.WT_API_UPSTREAM ?? 'https://kiasa.tech';

export function logLocally(endpoint: string, payload: unknown) {
  if (process.env.NODE_ENV === 'production') return;
  console.info(`[api] ${endpoint}`, JSON.stringify(payload).slice(0, 400));
}

/** Forward verbatim to the live PHP endpoint when WT_API_PROXY=1. */
export async function proxy(request: Request, phpPath: string): Promise<Response> {
  const body = request.method === 'GET' ? undefined : await request.text();
  const upstream = await fetch(`${UPSTREAM}${phpPath}`, {
    method: request.method,
    headers: { 'Content-Type': request.headers.get('content-type') ?? 'application/json' },
    body,
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
