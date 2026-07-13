// app/auth/callback/route.ts
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // Token can come from query param (email flow) or cookie (Google OAuth flow)
  const inviteToken = searchParams.get('token')
    || request.cookies.get('invite_token')?.value
    || null

  if (code) {
    const response = NextResponse.redirect(`${origin}/dashboard/projects`)

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) { return request.cookies.get(name)?.value },
          set(name: string, value: string, options: CookieOptions) {
            response.cookies.set({ name, value, ...options })
          },
          remove(name: string, options: CookieOptions) {
            response.cookies.set({ name, value: '', ...options })
          },
        },
      }
    )

    // Exchange code for session
    const { data: { user }, error } = await supabase.auth.exchangeCodeForSession(code)

    if (error || !user) {
      return NextResponse.redirect(`${origin}/login?error=auth_failed`)
    }

    // Ensure profile exists
    await supabase.from('profiles').upsert({
      id: user.id,
      email: user.email,
      full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || '',
      is_active: true,
    }, { onConflict: 'id' })

    // Handle invite token — add user to company
    if (inviteToken) {
      const { data: tokenData } = await supabase
        .from('registration_tokens')
        .select('id, company_id, used_at, expires_at, default_team_id')
        .eq('token', inviteToken)
        .single()

      if (
        tokenData &&
        !tokenData.used_at &&
        (!tokenData.expires_at || new Date(tokenData.expires_at) > new Date())
      ) {
        const companyId = tokenData.company_id

        if (companyId) {
          // Add to company_memberships
          await supabase.from('company_memberships').upsert({
            company_id: companyId,
            user_id: user.id,
            role: 'operator',
          }, { onConflict: 'user_id,company_id' })

          // Set active company
          await supabase.from('profiles')
            .update({ active_company_id: companyId })
            .eq('id', user.id)

          // Add to default team if specified
          if (tokenData.default_team_id) {
            await supabase.from('team_members').upsert({
              team_id: tokenData.default_team_id,
              profile_id: user.id,
            }, { onConflict: 'team_id,profile_id' })
          }

          // Mark token as used
          await supabase.from('registration_tokens')
            .update({ used_at: new Date().toISOString(), used_by: user.id })
            .eq('token', inviteToken)

          // Clear the invite cookie
          response.cookies.set('invite_token', '', { maxAge: 0, path: '/' })
        }
      }
    }

    return response
  }

  // No code — redirect to login
  return NextResponse.redirect(`${origin}/login`)
}