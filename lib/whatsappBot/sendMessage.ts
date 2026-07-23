// lib/whatsappBot/sendMessage.ts
// Outbound side of the WhatsApp Cloud API for the bot's replies -- see
// app/api/whatsapp/webhook/[companyId]/route.ts. Confirmed against
// developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
// (2026-07-24). Unlike Bot Framework (lib/msTeamsBot/connector.ts), there's
// no separate token-exchange step -- the stored access_token (a long-lived
// Meta System User token) is used directly as the bearer token.
export interface WhatsAppSendCredentials {
  access_token: string;
  phone_number_id: string;
}

// A message from inside a group we created via the Groups API (see
// lib/whatsappBot/groups.ts) must be replied to with recipient_type:
// "group" and `to` set to the group id, not the individual sender's own
// number -- see the Context note in the plan about why a business number
// can't join an *existing* WhatsApp group, only ones this app creates.
export type WhatsAppDestination = { type: "individual"; waId: string } | { type: "group"; groupId: string };

export async function sendWhatsAppReply(
  credentials: WhatsAppSendCredentials,
  destination: WhatsAppDestination,
  replyToMessageId: string,
  text: string
): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/v21.0/${credentials.phone_number_id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.access_token}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: destination.type === "group" ? "group" : "individual",
      to: destination.type === "group" ? destination.groupId : destination.waId,
      context: { message_id: replyToMessageId },
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status} ${await res.text()}`);
}
