// All prompt templates and the prospect-context builder. Kept apart from UI so prompt
// iteration (the most frequent change for an AI product) never touches component code.
import { HUMANIZE } from "./brand.js";

// Loader stage labels.
export const STAGES_ANALYZE = ["Analyzing prospect…", "Mapping responsibilities…", "Identifying pain points…", "Reading industry signals…", "Scoring fit…", "Building intelligence profile…"];
export const STAGES_GEN = ["Analyzing prospect…", "Understanding industry…", "Identifying pain points…", "Building personalization…", "Generating outreach…", "Humanizing language…"];

const ARR = `Return ONLY a valid JSON array (no markdown, no commentary).`;

// Lightweight COMPANY-only research (one web-search call).
export const COMPANY_SYSTEM = `You are a precise B2B company researcher for Karma Staff. State only facts you can verify from web search and the company's own website. Never fabricate names, numbers, or claims. Leave any field you cannot verify as an empty string "". Return ONLY a single valid JSON object, no markdown or code fences, starting with { and ending with }.`;

export function companyResearchPrompt(prospect, coUrl) {
  const L = (k, v) => (v && String(v).trim() ? k + ": " + String(v).trim() + "\n" : "");
  let s = "Research THIS COMPANY for B2B sales prep (restoration / construction staffing context).\n";
  s += L("Company website", coUrl);
  s += L("Company name", prospect.company);
  s += L("Industry (if known)", prospect.industry);
  s += L("Location (if known)", prospect.location);
  s += `\nUsing ONE targeted web search (the company site first), extract verifiable COMPANY facts only. Return ONLY this JSON:
{"company":"","website":"","industry":"","location":"","employeeCount":"","companyDesc":"","services":[],"recentNews":[],"summary":""}
- "companyDesc": 1-2 sentences on what they do. "services": up to 4 short items. "recentNews": up to 2 short, dated signals (hiring, expansion, storm season, etc.).
- "summary": one neutral sentence on what you found. Leave anything unverifiable as "". Start with { end with }.`;
  return s;
}

export function buildContext(p, offer, analysis, org) {
  const L = (k, v) => (v && String(v).trim() ? k + ": " + String(v).trim() + "\n" : "");
  let s = "PROSPECT\n";
  s += L("Name", [p.firstName, p.lastName].filter(Boolean).join(" "));
  s += L("Job title", p.title); s += L("Company", p.company); s += L("Industry", p.industry); s += L("Location", p.location);
  s += L("LinkedIn headline", p.headline); s += L("LinkedIn about", p.about); s += L("LinkedIn experience", p.experience);
  s += L("Company website", p.website); s += L("Company description", p.companyDesc); s += L("Recent news / signals", p.news);
  s += L("Personal notes", p.notes); s += L("Mutual interests", p.mutual); s += L("Additional research", p.research);
  s += L("Known pain points", p.pain); s += L("Growth objectives", p.growth); s += L("Staffing challenges", p.staffing); s += L("Operational challenges", p.ops);
  if (p.context && String(p.context).trim()) {
    s += "\nCONTEXT FROM THE USER (what the salesperson knows about this lead — treat as high-priority, accurate first-hand knowledge; weave it in naturally and never contradict it):\n" + String(p.context).trim() + "\n";
  }
  s += "\nSENDER (you are reaching out on behalf of):\n" + offer.trim() + "\n";
  if (org && org.trim()) s += "\nORGANIZATIONAL KNOWLEDGE (admin-provided — use when relevant, never contradict it):\n" + org.trim() + "\n";
  if (analysis) s += "\nYOUR INTELLIGENCE PROFILE OF THIS PROSPECT:\n" + JSON.stringify(analysis) + "\n";
  return s;
}

export function pAnalysis(base) {
  // Note: fit scores are computed deterministically in code (lib/scoring.js -> scoreFit),
  // so we do NOT ask the model for them — that output was generated and discarded.
  return base + `\nTASK: Build a concise intelligence profile of this prospect to drive personalized outreach. Infer from role and industry where data is missing, but never fabricate specific facts.

CRITICAL OUTPUT RULES:
- Return ONLY a single valid JSON object. No markdown. No code fences. No preamble. Start with { and end with }.
- Every string value must be properly JSON-escaped. No unescaped quotes or newlines inside strings.
- Keep every array item under 12 words. Keep "persona" under 40 words.
- All arrays must have exactly the count specified — no more, no fewer.
- For "hooks" (connection angles), prefer clearly recent signals (about the last 1-2 weeks); never base a hook on an old, stale, or undated post.

Return this exact structure:
{"persona":"2-3 sentence portrait (under 40 words total)","responsibilities":["item 1","item 2","item 3","item 4"],"painPoints":["item 1","item 2","item 3","item 4"],"goals":["item 1","item 2","item 3"],"hooks":["item 1","item 2","item 3","item 4"],"trends":["item 1","item 2","item 3"],"challenges":["item 1","item 2","item 3"]}`;
}

export function pConnection(base, n, avoid) {
  return base + `\nTASK: Write ${n} DISTINCT LinkedIn CONNECTION REQUEST notes (the short note on an invite).\nHARD RULES:\n- Each note MUST be 300 characters or fewer (keep a safe margin).\n- NEVER pitch, sell, mention services/staffing, or ask for a meeting or call. The ONLY goal is an accepted, personal-feeling connection.\n- Each note uses a clearly DIFFERENT angle.\n${avoid && avoid.length ? "- Do NOT reuse these angles: " + avoid.join("; ") + "\n" : ""}${HUMANIZE}\n${ARR} ${n} objects:\n[{"message":"the note","angle":"2-4 word label","personalization":<int 58-96>,"acceptance":<int 58-95>,"reasoning":"one sentence on why it lands"}]`;
}

export function pInmail(base, n, avoid) {
  return base + `\nTASK: Write ${n} DISTINCT LinkedIn INMAIL messages (the premium message sent to someone you are NOT connected with — they may have ignored a connection request). Each has a SUBJECT LINE and a BODY.
CONTEXT: Unlike a connection note, here you ARE allowed to introduce who you are, who you're reaching out on behalf of, and why it's relevant to them. This is a real first-touch outreach message, not just an icebreaker. Keep it warm, human, and specific, not a hard pitch.
HARD RULES:
- SUBJECT: under 60 characters, specific and curiosity-driven. NEVER generic ("Quick question", "Reaching out", "Connecting"). Make it about THEM or a concrete value, no clickbait.
- BODY: 4-7 sentences (roughly 90-160 words). Open with a genuine, personalized reason for reaching out (their role, company, a recent signal, or the user-provided context). Briefly say who you are / who you represent and the single most relevant reason it's worth their time. End with ONE low-friction ask (a quick reply or a short call), never pushy.
- Reference real, specific details from the prospect data. Never fabricate facts. Prefer clearly recent signals (about the last 1-2 weeks); never lean on stale, undated posts.
- Each message uses a clearly DIFFERENT angle and subject.
${avoid && avoid.length ? "- Do NOT reuse these angles: " + avoid.join("; ") + "\n" : ""}${HUMANIZE}
${ARR} ${n} objects:
[{"subject":"the subject line","message":"the InMail body","angle":"2-4 word label","personalization":<int 58-96>,"acceptance":<int 50-90>,"reasoning":"one sentence on why it lands"}]`;
}

// Per-message refine: the user likes a message but wants a specific change. Rewrite THAT
// message applying their instruction while staying aligned with the original (same intent,
// angle, tone, and the real details it used). Returns ONE object of the same shape.
const REFINE_RULES = {
  connection: "It is a LinkedIn CONNECTION REQUEST note: 300 characters or fewer, NO pitch/selling/meeting ask — only earn an accepted, personal connection.",
  inmail: "It is a LinkedIn INMAIL to a non-connection: keep a SUBJECT under 60 chars plus a 4-7 sentence body; you may introduce who you are and why you're reaching out.",
  relationship: "It is a post-connection first message: build rapport and start a conversation, NO pitch or meeting ask.",
  meeting: "It is a meeting request: value-focused, non-salesy, make the ask an easy yes.",
  followup: "It is a follow-up message: move things forward without being pushy; never a generic 'just checking in'.",
};

export function pRefine(base, kind, original, instruction, meta = {}) {
  const isInmail = kind === "inmail";
  const rules = REFINE_RULES[kind] || "";
  let s = base + `\nTASK: The user likes the message below but wants it refined. Rewrite it applying their requested change while STAYING ALIGNED with the original — keep its core intent, angle, tone and the specific real details it referenced. Change only what the instruction asks; do NOT start over or invent new facts.\n`;
  s += `\nORIGINAL MESSAGE:\n"""\n${meta.subject ? "Subject: " + meta.subject + "\n" : ""}${original}\n"""\n`;
  s += `\nWHAT THE USER WANTS CHANGED:\n"""\n${String(instruction || "").trim()}\n"""\n`;
  s += `\nCONSTRAINTS: ${rules}\n${HUMANIZE}\n`;
  s += `Return ONLY a single valid JSON object (no markdown, no array, no preamble):\n`;
  s += isInmail
    ? `{"subject":"the subject line","message":"the refined body","angle":"2-4 word label","personalization":<int 58-96>,"acceptance":<int 50-90>,"reasoning":"one sentence on what you changed"}`
    : `{"message":"the refined message","angle":"2-4 word label","personalization":<int 58-96>,"acceptance":<int 55-92>,"reasoning":"one sentence on what you changed"}`;
  return s;
}

// Message coach: critique ONE generated message against the brand voice + cold-outreach best
// practices, then return a stronger rewrite of the SAME message (same intent, angle, real
// facts). Returns { notes: [short weaknesses], improved: {same shape as the message} }.
const COACH_RULES = {
  connection: "LinkedIn CONNECTION note: 300 chars or fewer, NO pitch/selling/meeting ask — only earn an accepted, personal connection.",
  inmail: "LinkedIn INMAIL to a non-connection: a SUBJECT under 60 chars plus a 4-7 sentence body; you may introduce who you are and why you're reaching out.",
  relationship: "Post-connection first message: build rapport, start a conversation, NO pitch or meeting ask.",
  meeting: "Meeting request: value-focused, low-pressure, make the ask an easy yes.",
  followup: "Follow-up: move things forward without being pushy; never a generic 'just checking in'.",
};

export function pCoach(base, kind, message, subject, orig = {}) {
  const isInmail = kind === "inmail";
  const rules = COACH_RULES[kind] || COACH_RULES.connection;
  const op = Number.isFinite(orig.personalization) ? orig.personalization : null;
  const oa = Number.isFinite(orig.acceptance) ? orig.acceptance : null;
  let s = base + `\nTASK: You are a demanding cold-outreach coach. Critique the message below, then rewrite it STRONGER while keeping its core intent, angle, tone and the specific real facts it used. Do not invent new facts. Fix weak openers, generic lines, anything that reads as AI or a template, and any brand-voice violations.\n`;
  s += `\nMESSAGE TYPE RULES: ${rules}\n`;
  s += `\nMESSAGE TO COACH:\n"""\n${subject ? "Subject: " + subject + "\n" : ""}${message}\n"""\n`;
  if (op != null || oa != null) {
    s += `\nThe original scored ${op != null ? "personalization " + op : ""}${op != null && oa != null ? " and " : ""}${oa != null ? "acceptance " + oa : ""}. Your rewrite MUST be genuinely better, so its "personalization" and "acceptance" MUST both be HIGHER than the original — never equal or lower.\n`;
  }
  s += `\n${HUMANIZE}\n`;
  s += `Return ONLY a single valid JSON object (no markdown, no preamble):\n`;
  s += isInmail
    ? `{"notes":["short weakness 1","short weakness 2"],"improved":{"subject":"the subject line","message":"the stronger body","angle":"2-4 word label","personalization":<int 58-96>,"acceptance":<int 50-90>,"reasoning":"one sentence on what you improved"}}`
    : `{"notes":["short weakness 1","short weakness 2"],"improved":{"message":"the stronger message","angle":"2-4 word label","personalization":<int 58-96>,"acceptance":<int 55-92>,"reasoning":"one sentence on what you improved"}}`;
  s += `\n- "notes": 1-3 items, each under 12 words, naming a concrete weakness you fixed.`;
  return s;
}

// Learn-from-results: given this account's WINNING messages (the lead replied / booked / won)
// and its non-winning ones for a kind, distill a short playbook of what actually works here.
// Returns plain text (bulleted rules) that gets injected verbatim into future generation.
const KIND_NAME = { connection: "LinkedIn connection notes", relationship: "post-connection first messages", inmail: "LinkedIn InMails", meeting: "meeting-request messages", followup: "follow-up messages" };

export function pLearnPlaybook(kind, winners, others) {
  const fmt = (arr) => arr.map((m, i) => `${i + 1}. ${String(m || "").replace(/\s+/g, " ").trim().slice(0, 400)}`).join("\n");
  let s = `You are analysing real cold-outreach results for Karma Staff to find what makes ${KIND_NAME[kind] || "messages"} succeed.\n\n`;
  s += `WON — the prospect replied, booked a meeting, or became a client after receiving one of these:\n${winners.length ? fmt(winners) : "(none yet)"}\n\n`;
  s += `GHOSTED / REJECTED — these got no reply at all, or the prospect passed:\n${others.length ? fmt(others) : "(none yet)"}\n\n`;
  s += `TASK: Compare them and extract what the winners do that the others don't. Focus on concrete, repeatable patterns: opener style, personalization, length, tone, specific angles, what to avoid.\n`;
  s += `Return 4-7 SHORT imperative rules (one line each, start each with "- "). No preamble, no numbering, no headings. Each rule must be specific enough to change how the next message is written. If the winners are too few to be sure, say so in the first line and give your best provisional guidance.`;
  return s;
}

export function pRelationship(base, n, avoid) {
  return base + `\nTASK: The prospect just ACCEPTED the connection. Write ${n} DISTINCT first messages that build a relationship.\nHARD RULES:\n- Build rapport, start a real conversation. NO pitching, NO selling, NO meeting ask.\n- Reference role / company / industry / background in a way that invites a reply. 2-4 sentences. Different conversational style each.\n${avoid && avoid.length ? "- Do NOT reuse these styles/angles: " + avoid.join("; ") + "\n" : ""}${HUMANIZE}\n${ARR} ${n} objects:\n[{"message":"the message","angle":"2-4 word style label","personalization":<int 58-96>,"acceptance":<int 55-92>,"reasoning":"one sentence on why it earns a reply"}]`;
}

const MEET_LEN = {
  short: "SHORT body — 1-2 tight sentences. Direct, friendly, one clear value.",
  standard: "STANDARD body — 3-4 sentences. Set context, name a reason it is worth 15 min, easy yes.",
  executive: "EXECUTIVE body — 2-3 sentences. Peer-to-peer, time-respecting, outcome-focused.",
};

export function pMeeting(base, n, len, avoid, reply) {
  const replyBlock = reply && reply.trim() ? `

THE PROSPECT JUST REPLIED TO YOU. Their exact message:
"""
${reply.trim()}
"""
FIRST, silently read their reply and gauge its tone and intent (e.g. warm, curious, skeptical, busy, positive, hesitant, asking a question, raising an objection). THEN write meeting requests that:
- Directly respond to what they actually said. Acknowledge their specific point in your own words before moving to the ask. Never ignore their message or send a generic cold ask.
- Match their tone and energy. If they were warm, be warm; if brief and busy, be short and respectful; if skeptical, be low-pressure and reassuring; if they asked something, answer it briefly first.
- Still lead naturally to a short call using the format below.
` : "";
  return base + replyBlock + `\nTASK: Rapport is established. Write ${n} DISTINCT MEETING REQUEST messages. Body length: ${MEET_LEN[len]}

MANDATORY FORMAT — every message MUST follow this exact structure, no exceptions:
Hi [prospect first name],

[body content here — personalized, value-focused, low-pressure, ends with the calendar link on its own line]

[CALENDAR LINK — paste the exact link from the sender section, on its own line, no label before it]

Best,
[SIGN-OFF NAME from sender section]
[EMAIL from sender section]
www.karmastaff.com

HARD RULES:
- The greeting is always "Hi [first name]," on its own line, then a blank line before the body.
- The calendar link goes AFTER the body, on its own line, before the sign-off.
- The sign-off block is always exactly: Best, / [first name only] / [email] / www.karmastaff.com — each on its own line.
- Body is value-focused, personalized, natural. Never salesy or pushy. Make clear why a short conversation is worth their time. Different value angle each variation.
- TRUST: in roughly half of the variations, work in ONE credibility marker from the sender's proof points (most naturally "IICRC certified" or "vendor member of RIA") as a brief, plain aside that signals we know the restoration trade and take accountability seriously. Keep it woven into a sentence, never a badge list, never in every variation, never boastful.
- No extra commentary, no labels, no asterisks around any part.
${avoid && avoid.length ? "- Do NOT reuse these angles: " + avoid.join("; ") + "\n" : ""}${HUMANIZE}
${ARR} ${n} objects:
[{"message":"the full formatted message exactly as it should be sent","angle":"2-4 word value angle","personalization":<int 58-96>,"acceptance":<int 45-88>,"reasoning":"one sentence on why it converts"}]`;
}

// The follow-up stages of a Karma Staff engagement (the client interviews and hires our
// trained candidates). Exported so the UI can offer them. One email is generated per stage.
export const FOLLOWUP_STAGES = [
  { v: "post_meeting", label: "After the meeting", intent: "We just had a good intro/discovery meeting. Thank them for their time, briefly reinforce the value of our trained candidates, and propose the clear next step: setting up interviews with one or more of our candidates." },
  { v: "schedule_interview", label: "Schedule a candidate interview", intent: "They're open to interviewing one of our trained candidates. Make it easy to lock in a date and time; offer specifics and reduce friction so they commit to an interview slot." },
  { v: "interview_booked", label: "Interview booked — confirm", intent: "A candidate interview is scheduled. Confirm the time, give brief helpful context on the candidate, and set expectations so the interview goes well." },
  { v: "post_interview", label: "After the interview — get feedback", intent: "The interview has happened. Ask for honest feedback, find out which candidate they're leaning toward, and keep momentum toward a hiring decision." },
  { v: "selected_go", label: "Candidate chosen — moving ahead", intent: "They've chosen a candidate and want to proceed. Move toward closing: confirm the selection and outline the next steps (offer, paperwork, start date) to make starting smooth." },
  { v: "selected_timing", label: "Chosen — deciding start date", intent: "They've chosen a candidate but need time to decide the start date. Stay warm and helpful, remove blockers, and gently guide them to commit to a start date." },
  { v: "closing", label: "Closing the deal", intent: "They've confirmed they'll go ahead with the candidate from a specific start date. Confirm the details and next steps and close the engagement professionally and warmly." },
];

// The original 5-step LinkedIn follow-up sequence (for when there's no reply yet).
export function pFollowupSequence(base) {
  return base + `\nTASK: No reply after the meeting request. Write a 5-step FOLLOW-UP SEQUENCE. Each step MUST introduce something genuinely NEW — never repeat earlier messages, never use "just checking in" / "following up" / "circling back".

Steps (in order): 1) Gentle reminder  2) New insight  3) Different angle  4) Industry-specific observation  5) Respectful close-out (graceful, no guilt).

MANDATORY FORMAT for every step — follow this exact structure:
Hi [prospect first name],

[body — 2-3 sentences, something genuinely new each time]

[CALENDAR LINK from sender section on its own line — include on steps 1 through 4 only, omit on step 5 close-out]

Best,
[SIGN-OFF NAME from sender section]
[EMAIL from sender section]
www.karmastaff.com

${HUMANIZE}
${ARR} EXACTLY 5 objects in order:
[{"stage":"Gentle reminder","message":"the full formatted message","fresh":"the new element introduced","reasoning":"why it works"}]`;
}

export function pFollowup(base, stage, transcript) {
  const s = stage || FOLLOWUP_STAGES[0];
  const hasT = transcript && transcript.trim();
  const t = hasT ? `\n\nCALL / MEETING TRANSCRIPT (rely on this heavily — reference specific things they actually said; never contradict or invent):\n"""\n${transcript.trim().slice(0, 12000)}\n"""\n` : "";
  return base + t + `\nTASK: Write ONE follow-up email for THIS stage of a staffing engagement (Karma Staff places trained candidates with the client, who interviews and hires them).
STAGE: ${s.label}
GOAL OF THIS EMAIL: ${s.intent}

HARD RULES:
- Output EXACTLY ONE email — not a sequence, not multiple variations.
- ${hasT ? "Ground it in the transcript: reference at least one specific, real point they made. " : "Use only the known facts above; never invent specifics. "}Natural, warm, concise, human. Never "just checking in".
- Make the next step crystal clear and easy, matched to the stage goal. Low-pressure.
- When proposing a time to meet or interview, include the sender's calendar link on its own line; otherwise omit it.

MANDATORY FORMAT:
Hi [prospect first name],

[body — 2-4 short sentences, specific to this stage and (if present) the transcript]

[CALENDAR LINK from the sender section on its own line — only when proposing a time]

Best,
[SIGN-OFF NAME from sender section]
[EMAIL from sender section]
www.karmastaff.com
${HUMANIZE}
Return ONLY a single JSON object (no markdown): {"stage":"${s.label}","message":"the full email exactly as it should be sent","reasoning":"one sentence on why this fits the stage"}`;
}
