// lib/billing/aiUsageCap.ts
// Current-billing-period token usage vs. a company's monthly_token_cap
// (see ai_chat_settings.sql) -- shared by app/api/ai/chat/route.ts and
// app/api/teams/bot/[companyId]/route.ts so both enforce the exact same
// cap against the exact same usage pool (ai_usage_events is company-wide,
// not per-channel).
export async function isTokenCapReached(admin: any, companyId: string, tokenCap: number): Promise<boolean> {
  const periodStart = new Date();
  periodStart.setDate(1);
  periodStart.setHours(0, 0, 0, 0);

  const { data: periodEvents } = await admin
    .from("ai_usage_events")
    .select("input_tokens, output_tokens")
    .eq("company_id", companyId)
    .gte("created_at", periodStart.toISOString());

  const tokensUsed = (periodEvents ?? []).reduce((sum: number, e: any) => sum + e.input_tokens + e.output_tokens, 0);
  return tokensUsed >= tokenCap;
}
