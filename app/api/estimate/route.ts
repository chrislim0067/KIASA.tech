import { NextResponse } from 'next/server';
import { PROXY, logLocally, proxy, readJson } from '@/lib/api/dev';

/**
 * Stands in for api/estimate.php — the server-side price check the estimate flow
 * uses to verify the figure it computed in the browser. Contract: POST
 * { schema, service, option_ids, quantities } -> { usd }.
 *
 * Without the real catalogue this cannot re-derive a price, so it echoes the
 * client's own total when supplied and otherwise returns 0. estimate-flow.js
 * treats a mismatch as unverified rather than erroring.
 */
export async function POST(request: Request) {
  if (PROXY) return proxy(request, '/api/estimate.php');

  const payload = await readJson(request);
  logLocally('estimate', payload);
  const usd = Number(payload.usd ?? payload.total ?? 0);
  return NextResponse.json({ usd: Number.isFinite(usd) ? usd : 0 });
}
