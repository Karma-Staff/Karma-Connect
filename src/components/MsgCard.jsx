import { CopyIc, RegenIc, StarIc } from "./icons.jsx";

// One generated message: index/angle chips, optional char counter, score bars, AI-coach note, actions.
export function MsgCard({ item, idx, kind, charLimit, favOn, onCopy, onRegen, onFav, regening }) {
  const over = charLimit && item.message && item.message.length > charLimit;
  return (
    <div className="mcard">
      <div className="mctop">
        <span className="chip idx">{String(idx + 1).padStart(2, "0")}</span>
        {item.angle && <span className="chip">{item.angle}</span>}
        {charLimit && <span className={"charc" + (over ? " over" : "")}>{(item.message || "").length}/{charLimit}</span>}
      </div>
      <div className="mbody">{item.message}</div>
      {(typeof item.personalization === "number" || typeof item.acceptance === "number") && (
        <div className="scores">
          {typeof item.personalization === "number" && (
            <div className="score"><div className="sl"><span>Personalization</span><b>{item.personalization}%</b></div><div className="bar"><i style={{ width: item.personalization + "%" }} /></div></div>
          )}
          {typeof item.acceptance === "number" && (
            <div className="score"><div className="sl"><span>{kind === "connection" ? "Acceptance" : kind === "relationship" ? "Reply odds" : "Meeting odds"}</span><b>{item.acceptance}%</b></div><div className="bar alt"><i style={{ width: item.acceptance + "%" }} /></div></div>
          )}
        </div>
      )}
      {item.reasoning && <div className="reason"><b>AI Coach</b> · {item.reasoning}</div>}
      <div className="mact">
        <button className="iconbtn" onClick={() => onCopy(item.message)}>{CopyIc} Copy</button>
        <button className="iconbtn" onClick={onRegen} disabled={regening}>{RegenIc} {regening ? "…" : "Regenerate"}</button>
        <button className={"iconbtn fav" + (favOn ? " on" : "")} onClick={onFav} aria-label={favOn ? "Remove from favorites" : "Add to favorites"} aria-pressed={favOn} style={{ marginLeft: "auto" }}>{StarIc(favOn)}</button>
      </div>
    </div>
  );
}
