import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  const { pathname } = request.nextUrl;

  // Allow Google verification files through
  if (pathname.startsWith('/google')) return NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options })
          response = NextResponse.next({ request: { headers: request.headers } })
          response.cookies.set({ name, value, ...options })
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: '', ...options })
          response = NextResponse.next({ request: { headers: request.headers } })
          response.cookies.set({ name, value: '', ...options })
        },
      },
    }
  )

  // getSession() reads and verifies the JWT from the cookie locally — no
  // network round-trip to Supabase's auth server. Proxy runs on every
  // request (including prefetches), so per Next.js's own guidance this
  // check should stay "optimistic": redirect based on the cookie, and leave
  // real authorization to RLS and each page's own checks, not Proxy. That's
  // already how this app works — Proxy is only a UX-level redirect gate,
  // never the actual security boundary.
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user

  // Logged-in user on homepage → redirect to dashboard immediately
  if (user && pathname === '/') {
    return NextResponse.redirect(new URL('/dashboard/projects', request.url))
  }

  // Unauthenticated user on dashboard → redirect to login
  if (!user && pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|public).*)',
    '/dashboard/:path*',
  ],
}