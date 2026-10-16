// AI drafts for LinkedIn replies. The draft is only a suggestion: it lands in an editable box in
// the Send Queue and nothing is sent until a person approves it there.
import { anthropicMsg, CLAUDE_MODEL } from "./claude.js";
import { SYSTEM, HUMANIZE } from "./brand.js";
import { senderOffer } from "./senders.js";

const REPLY_RULES = `You are writing the NEXT LinkedIn reply in an existing conversation between a Karma Staff team member ("me") and a prospect ("them").

RULES:
- Answer what they actually said. If they asked a question, answer it plainly from the company facts provided.
- Short: 1 to 4 sentences, like a real person replying on LinkedIn. No subject line, no signature block.
- Never invent prices, rates, contract terms, availability, client names, or numbers. If they ask about price or anything you can't answer from the facts, say it depends on the role and hours and suggest a short call to work it out.
- If they show interest, suggest a quick call and include the sender's calendar link on its own line.
- If they say no, not now, or ask to stop, reply graciously in one sentence, offer nothing more, and do not push.
- If they are rude or the message is spam, write a single polite closing line.
- Match their tone and formality. Use their first name at most once.
- Output ONLY the reply text. No quotes, no preamble, no options.`;

// thread: { name, messages: [{ from: 'them'|'me', text }] }; sender: one of SENDERS.
export async function draftReply(thread, sender) {
  const convo = (thread.messages || []).slice(-14)
    .map((m) => (m.from === "them" ? (thread.name || "Them") : "Me") + ": " + m.text)
    .join("\n\n");
  const user = `${senderOffer(sender)}

PROSPECT: ${thread.name || "the prospect"}${thread.lead_label && thread.lead_label !== thread.name ? " (saved as " + thread.lead_label + ")" : ""}

CONVERSATION SO FAR (oldest first):
${convo}

Write my reply to their last message.`;
  const txt = await anthropicMsg(SYSTEM + "\n\n" + HUMANIZE + "\n\n" + REPLY_RULES, user, { maxTokens: 600, model: CLAUDE_MODEL });
  return String(txt || "").trim().replace(/^["“]|["”]$/g, "").trim();
}
