import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const EMAIL = `verify-pdf-${Date.now()}@example.com`;
const PASSWORD = "Verify-Test-Passw0rd!";

async function main() {
  const { data: userRes, error: userErr } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
  });
  if (userErr) throw userErr;
  const userId = userRes.user.id;

  const { data: company, error: companyErr } = await admin.from("companies").insert({
    name: "PDF Editor Test Co", status: "pending",
  }).select("id").single();
  if (companyErr) throw companyErr;

  await admin.from("profiles").insert({
    id: userId, email: EMAIL, full_name: "PDF Editor Test", is_active: true, active_company_id: company.id,
  });

  await admin.from("company_memberships").insert({
    user_id: userId, company_id: company.id, role: "company_admin",
  });

  const info = { email: EMAIL, password: PASSWORD, companyId: company.id, loginUrl: "http://localhost:3000/login" };
  console.log(JSON.stringify(info, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
