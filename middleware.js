// middleware.js
import { NextResponse } from "next/server";

export function middleware(req) {
  const url = req.nextUrl;
  const { pathname } = url;

  // Only protect /admin, but allow /admin/login and admin auth APIs
  const isAdminPath = pathname.startsWith("/admin");
  const isLoginPage = pathname === "/admin/login";
  const isAdminAuthApi =
    pathname === "/api/admin/login" || pathname === "/api/admin/logout";

  if (!isAdminPath) {
    return NextResponse.next();
  }

  // Read auth cookie
  const isAuthed = Boolean(req.cookies.get("admin")?.value);

  // If not logged in:
  if (!isAuthed) {
    // Allow the login page and auth APIs to pass through
    if (isLoginPage || isAdminAuthApi) {
      return NextResponse.next();
    }
    // Everything else under /admin → redirect to /admin/login
    const loginUrl = new URL("/admin/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // If logged in and trying to access the login page, bounce to /admin
  if (isAuthed && isLoginPage) {
    const adminUrl = new URL("/admin", req.url);
    return NextResponse.redirect(adminUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Only run on admin pages and admin auth APIs
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
