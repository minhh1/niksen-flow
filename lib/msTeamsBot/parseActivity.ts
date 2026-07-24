// lib/msTeamsBot/parseActivity.ts
// Turns a raw Bot Framework Activity into the plain IncomingMessage shape
// lib/msTeamsBot/handleMessage.ts's bot brain consumes -- shared by both
// messaging endpoints (app/api/teams/bot/[companyId]/route.ts's BYO path
// and app/api/teams/bot/shared/route.ts's shared-bot path), since neither
// this parsing nor the bot brain itself depends on which credentials mode
// is in play.
export interface IncomingMessage {
  aadObjectId: string;
  tenantId: string;
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  question: string;
  reactionTargetId?: string;
  isGroup: boolean;
  senderName?: string;
}

function stripMentionMarkup(text: string): string {
  return text.replace(/<at>.*?<\/at>/g, "").trim();
}

// Bot Framework activities carry a "mention" entity referencing whoever was
// @mentioned; `mentioned.id` is compared against `recipient.id` (the bot's
// own id as seen in this specific conversation) rather than the literal
// <at> text, since a channel message might @mention a different user/bot
// entirely.
function wasBotMentioned(activity: any): boolean {
  const entities = activity.entities as Array<{ type?: string; mentioned?: { id?: string } }> | undefined;
  return !!entities?.some((e) => e.type === "mention" && e.mentioned?.id === activity.recipient?.id);
}

// Returns null when the activity needs nothing more than an ack -- a
// typing indicator, a non-like reaction, conversationUpdate, or (in a
// non-1:1 conversation) a message that didn't actually @mention the bot.
export function parseIncomingActivity(activity: any): IncomingMessage | null {
  // A "like" reaction on the bot's own confirmation message counts as a
  // "yes" -- lets someone confirm a pending create/update without typing a
  // word. `replyToId` on a messageReaction activity identifies exactly
  // which message was reacted to (the Connector API's standard reply
  // property), verified in handleMessage against the prompt_message_id
  // captured when that confirmation was sent.
  const isLikeReaction = activity.type === "messageReaction" && (activity.reactionsAdded ?? []).some((r: { type?: string }) => r.type === "like" || r.type === "plusOne");
  const reactionTargetId: string | undefined = isLikeReaction ? activity.replyToId : undefined;

  // Only real user messages (or a like-reaction confirm) need a reply --
  // conversationUpdate (bot added/removed), typing indicators, other
  // reaction types, etc. are just acked.
  if (!isLikeReaction && (activity.type !== "message" || !activity.text)) {
    return null;
  }

  // In a group chat or channel, only respond when actually @mentioned --
  // replying to every unrelated message in a team channel would be noisy
  // and wrong. A 1:1 (personal) conversation has no one else to mention it
  // for, so every message there gets a reply. Reactions skip this check --
  // reacting to a specific message is inherently unambiguous about intent.
  const conversationType: string | undefined = activity.conversation?.conversationType;
  if (!isLikeReaction && activity.type === "message" && conversationType !== "personal" && !wasBotMentioned(activity)) {
    return null;
  }

  const question = isLikeReaction ? "\u{1F44D}" : stripMentionMarkup(activity.text);
  const aadObjectId: string | undefined = activity.from?.aadObjectId;
  const tenantId: string | undefined = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
  const serviceUrl: string = activity.serviceUrl;
  const conversationId: string = activity.conversation?.id;
  const activityId: string = activity.id;

  if (!aadObjectId || !tenantId || !question) {
    return null;
  }

  // Several people can have their own pending create/update flow going at
  // once in a shared channel/group chat -- everything the bot posts there
  // is visible to everyone with no other indication of who a prompt/result
  // is for, which reads as one shared queue even though the underlying
  // state (teams_bot_pending_actions, keyed by linked_account_id) is
  // already isolated per person. senderName (only needed outside a 1:1,
  // which is unambiguous on its own) is used to prefix the bot's replies --
  // see attribute() in lib/msTeamsBot/handleMessage.ts.
  const isGroup = conversationType !== "personal";
  const senderName: string | undefined = activity.from?.name;

  return { aadObjectId, tenantId, serviceUrl, conversationId, activityId, question, reactionTargetId, isGroup, senderName };
}
