import { CopyIc, RegenIc, StarIc, SendIc } from "./icons.jsx";
import { flagUnsupported } from "../lib/verify.js";
import { RefineBox } from "./RefineBox.jsx";

// One generated message: index/angle chips, optional char counter, score bars, AI-coach note, actions.
export function MsgCard({ item, idx, kind, charLimit, favOn, onCopy, onRegen, onFav, onRefine, onQueue, regening, source, onSent, sentOn, onImprove, coaching, coachNote }) {
  const over = charLimit && item.message && item.message.length > charLimit;
  // InMails carry a subject line; copy it together with the body.
  const copyText = item.subject ? "Subject: " + item.subject + "\n\n" + item.message : item.message;
  // Zero-token hallucination guard: numbers/names in the message not traceable to the user's data.
  const flags = source ? flagUnsupported(copyText, source) : [];
  return (
    <div className="mcard">
      <div className="mctop">
        <span className="chip idx">{String(idx + 1).padStart(2, "0")}</span>
        {item.angle && <span className="chip">{item.angle}</span>}
        {charLimit && <span className={"charc" + (over ? " over" : "")}>{(item.message || "").length}/{charLimit}</span>}
      </div>
      {item.subject && (
        <div className="msubj"><span className="msubj-l">Subject</span>{item.subject}</div>
      )}
      <div className="mbody" style={item.subject ? { whiteSpace: "pre-wrap" } : undefined}>{item.message}</div>
      {(typeof item.personalization === "number" || typeof item.acceptance === "number") && (
        <div className="scores">
          {typeof item.personalization === "number" && (
            <div className="score"><div className="sl"><span>Personalization</span><b>{item.personalization}%</b></div><div className="bar"><i style={{ width: item.personalization + "%" }} /></div></div>
          )}
          {typeof item.acceptance === "number" && (
            <div className="score"><div className="sl"><span>{kind === "connection" ? "Acceptance" : kind === "relationship" || kind === "inmail" ? "Reply odds" : "Meeting odds"}</span><b>{item.acceptance}%</b></div><div className="bar alt"><i style={{ width: item.acceptance + "%" }} /></div></div>
          )}
        </div>
      )}
      {item.reasoning && <div className="reason"><b>AI Coach</b> · {item.reasoning}</div>}
      {coachNote && coachNote.length > 0 && (
        <div className="reason" style={{ borderLeftColor: "var(--gold, #E7B74B)" }}><b>✦ Coached</b> · fixed: {coachNote.join("; ")}</div>
      )}
      {flags.length > 0 && (
        <div className="verify" title="These specifics aren't in the data you entered. Double-check them before sending — the AI may have invented them.">
          ⚠ Verify before sending: {flags.map((f) => f.claim).join(", ")}
        </div>
      )}
      <div className="mact">
        <button className="iconbtn" onClick={() => onCopy(copyText)}>{CopyIc} Copy{item.subject ? " all" : ""}</button>
        <button className="iconbtn" onClick={onRegen} disabled={regening}>{RegenIc} {regening ? "…" : "Regenerate"}</button>
        {onImprove && (
          <button className="iconbtn" onClick={onImprove} disabled={coaching} title="Let the coach critique and rewrite this message stronger">
            {coaching ? "Coaching…" : "✦ Improve"}
          </button>
        )}
        {onSent && (
          <button className={"iconbtn" + (sentOn ? " on" : "")} onClick={onSent} title="Mark this variant as the one you sent — feeds A/B analytics" aria-pressed={!!sentOn}>
            {sentOn ? "✓ Sent" : "Mark sent"}
          </button>
        )}
        {onQueue && <button className="iconbtn" onClick={onQueue} title="Queue this message to send">{SendIc} Queue</button>}
        <button className={"iconbtn fav" + (favOn ? " on" : "")} onClick={onFav} aria-label={favOn ? "Remove from favorites" : "Add to favorites"} aria-pressed={favOn} style={{ marginLeft: "auto" }}>{StarIc(favOn)}</button>
      </div>
      {onRefine && <RefineBox onRefine={onRefine} />}
    </div>
  );
}
