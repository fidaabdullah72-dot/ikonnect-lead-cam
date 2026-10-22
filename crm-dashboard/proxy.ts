import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { SUPABASE_ANON_KEY, SUPABASE_URL, USER_HEADER, isSupabaseConfigured } from '@/lib/env';

/** Pages for signed-out users only. */
const AUTH_PAGES = ['/login', '/signup', '/forgot-password'];
/** Pages anyone may open. */
const PUBLIC_PREFIXES = [...AUTH_PAGES, '/invite', '/auth', '/api/auth', '/setup', '/reset-password'];

/**
 * Refreshes the Supabase session cookie on every request and does the
 * optimistic redirects. Real authorization happens in Postgres (RLS).
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (!isSupabaseConfigured()) {
    if (path === '/setup') return NextResponse.next();
    return NextResponse.redirect(new URL('/setup', request.url));
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  const signedIn = Boolean(claims?.sub);

  const redirect = (to: URL) => {
    const r = NextResponse.redirect(to);
    for (const c of response.cookies.getAll()) r.cookies.set(c);
    return r;
  };

  const isPublic = PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  if (!signedIn && !isPublic) {
    if (path.startsWith('/api/')) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    }
    const url = new URL('/login', request.url);
    if (path !== '/') url.searchParams.set('next', path + request.nextUrl.search);
    return redirect(url);
  }
  if (signedIn && AUTH_PAGES.some((p) => path === p)) {
    return redirect(new URL('/dashboard', request.url));
  }
  if (!signedIn) return response;

  // Hand the user verified above to the app layout, so it doesn't ask Supabase again
  // (always overwritten here, so a browser can't supply its own).
  const headers = new Headers(request.headers);
  headers.set(USER_HEADER, encodeURIComponent(JSON.stringify({ id: claims!.sub, email: (claims!.email as string | undefined) ?? '' })));
  const next = NextResponse.next({ request: { headers } });
  for (const c of response.cookies.getAll()) next.cookies.set(c);
  return next;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
