// lib/whatsappBot/groups.ts
// Meta's official Groups API -- a business creates its *own new* WhatsApp
// group (members join via invite link); there is no way, on the official
// platform, to add a business number into an already-existing end-user
// group (confirmed against developers.facebook.com/documentation/
// business-messaging/whatsapp/groups and .../groups/reference, 2026-07-24).
// Requires the company's WhatsApp Business Account to be an "Official
// Business Account" -- a Meta-side designation this app can't grant, same
// kind of external prerequisite as the Teams bot's Azure setup steps (see
// components/admin/AdminWhatsAppTab.tsx's help drawer).
export interface CreatedWhatsAppGroup {
  id: string;
  inviteLink: string;
}

export async function createWhatsAppGroup(
  credentials: { access_token: string; phone_number_id: string },
  subject: string,
  description?: string
): Promise<CreatedWhatsAppGroup> {
  const res = await fetch(`https://graph.facebook.com/v21.0/${credentials.phone_number_id}/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.access_token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", subject, ...(description ? { description } : {}) }),
  });
  if (!res.ok) throw new Error(`WhatsApp group creation failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { id: json.id, inviteLink: json.invite_link };
}
