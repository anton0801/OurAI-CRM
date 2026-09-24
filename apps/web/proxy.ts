import { NextResponse, type NextRequest } from 'next/server';

/**
 * Network-boundary proxy (Next.js 16 `proxy.ts`): forwards the current path to server components
 * (used for sign-in return targets) and marks private pages as non-cacheable.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-castlane-path', request.nextUrl.pathname + request.nextUrl.search);
  const response = NextResponse.next({ request: { headers } });
  if (!request.nextUrl.pathname.startsWith('/_next/')) response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg|apple-touch-icon.png|app-icon-.*|manifest.webmanifest|brand/).*)'],
};
