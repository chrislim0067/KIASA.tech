import { NextResponse } from 'next/server';
import { PROXY, logLocally, proxy, readJson } from '@/lib/api/dev';

/** Stands in for api/lead.php. Contract: POST JSON -> { success, message? }. */
export async function POST(request: Request) {
  if (PROXY) return proxy(request, '/api/lead.php');

  const payload = await readJson(request);

  // Honeypot: the real endpoint silently accepts and drops these.
  if (typeof payload.botcheck === 'string' && payload.botcheck.trim() !== '') {
    return NextResponse.json({ success: true });
  }

  const missing = ['from_name', 'email'].filter((f) => !String(payload[f] ?? '').trim());
  if (missing.length) {
    return NextResponse.json({ success: false, message: `Missing: ${missing.join(', ')}` }, { status: 400 });
  }

  logLocally('lead', payload);
  return NextResponse.json({ success: true });
}
