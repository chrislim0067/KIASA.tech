import { NextResponse, type NextRequest } from 'next/server';

/**
 * Exposes the requested pathname to the experience layout (it needs the language of the
 * first requested page to render the loader in the right language; later client-side
 * navigations keep the shell, exactly like the original Taxi.js setup).
 */
export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set('x-kiasa-pathname', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/', '/about', '/contact', '/ja', '/ja/about', '/ja/contact', '/fr', '/fr/about', '/fr/contact'],
};
