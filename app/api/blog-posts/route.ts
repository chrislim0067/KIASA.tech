import { NextResponse } from 'next/server';
import posts from '@/content/blog-posts.json';
import { PROXY, proxy } from '@/lib/api/dev';

/**
 * Stands in for api/blog-posts.php. Contract: GET -> array of
 * { slug, title, excerpt, category, post_date, read_time, thumbnail, featured }.
 *
 * The payload is generated from the crawled post pages by scripts/gen-blog.mjs,
 * so /blog renders the real articles rather than its "unavailable" state.
 */
export async function GET(request: Request) {
  if (PROXY) return proxy(request, '/api/blog-posts.php');
  return NextResponse.json(posts);
}
