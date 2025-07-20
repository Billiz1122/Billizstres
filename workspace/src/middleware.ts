
import { NextResponse, type NextRequest } from 'next/server';
import { decrypt, COOKIE_NAME } from '@/lib/session';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { SiteSettings } from '@/lib/types';

// Define paths that are public and should not trigger authentication checks.
const PUBLIC_PATHS = ['/login', '/register', '/landing'];

// Define paths and files that the middleware should ignore completely.
const BYPASS_PATHS = [
  '/api/',
  '/_next/',
  '/static/',
  '/p/', // Crucially, bypass all phishing link routes.
];
const BYPASS_FILE_EXTENSIONS = /\.(.*)$/;

async function getMaintenanceStatus(): Promise<boolean> {
  try {
    const docRef = doc(db, 'settings', 'site');
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      const settings = docSnap.data() as SiteSettings;
      return settings.maintenanceMode || false;
    }
    return false;
  } catch (error) {
    console.error("Middleware: Could not fetch maintenance status, defaulting to false.", error);
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Immediately bypass if the path matches any of our exclusion criteria.
  if (
    BYPASS_PATHS.some((path) => pathname.startsWith(path)) ||
    BYPASS_FILE_EXTENSIONS.test(pathname)
  ) {
    return NextResponse.next();
  }

  // 2. Decrypt the session from the cookie.
  const sessionCookie = request.cookies.get(COOKIE_NAME);
  const session = await decrypt(sessionCookie?.value);
  const isAuthenticated = !!session;
  const userRole = session?.role;

  // 3. Check maintenance mode status FIRST. This is the highest priority check.
  const isInMaintenanceMode = await getMaintenanceStatus();

  if (isInMaintenanceMode) {
    // If maintenance mode is ON:
    // - Admins are allowed to go anywhere.
    // - Everyone else (logged in or not) is redirected to /maintenance, unless they are already there.
    if (userRole !== 'admin' && pathname !== '/maintenance') {
      return NextResponse.redirect(new URL('/maintenance', request.url));
    }
    // Allow admins and anyone on the maintenance page to proceed
    return NextResponse.next();
  } else {
    // If maintenance mode is OFF, and someone lands on the maintenance page, redirect them away.
    if (pathname === '/maintenance') {
      return NextResponse.redirect(new URL('/', request.url));
    }
  }

  // Handle root path separately, redirecting to dashboard or landing page.
  if (pathname === '/') {
    return NextResponse.redirect(new URL(isAuthenticated ? '/dashboard' : '/landing', request.url));
  }

  // 4. Handle authentication and authorization for all other paths now that maintenance is handled.
  if (isAuthenticated) {
    // If an authenticated user tries to access a public page (login/register/landing), redirect them to the dashboard.
    if (PUBLIC_PATHS.includes(pathname)) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    // If a non-admin/mod tries to access any admin pages, redirect them to the dashboard.
    if (pathname.startsWith('/admin') && !['admin', 'moderator'].includes(userRole as string)) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  } else {
    // If an unauthenticated user tries to access a protected page, redirect to login.
    // We don't need to check for '/maintenance' here because it's already handled.
    if (!PUBLIC_PATHS.includes(pathname)) {
        return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  // 5. If no other conditions are met, allow the request to proceed.
  return NextResponse.next();
}

// This config ensures the middleware runs on all paths,
// as the logic inside now handles the bypassing.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
