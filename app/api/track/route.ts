import { NextResponse } from 'next/server';
import { PROXY, logLocally, proxy, readJson } from '@/lib/api/dev';

/**
 * Stands in for api/track.php — the Meta Conversions API relay that wt-track.js
 * calls alongside the browser Pixel, sharing an event_id so Meta deduplicates.
 * Locally it only acknowledges: forwarding would write real conversions.
 */
export async function POST(request: Request) {
  if (PROXY) return proxy(request, '/api/track.php');
  logLocally('track', await readJson(request));
  return NextResponse.json({ success: true });
}
