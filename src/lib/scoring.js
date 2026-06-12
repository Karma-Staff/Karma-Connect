// Deterministic, explainable fit scoring. Same inputs always produce the same scores, and
// each score comes with a factor breakdown (label · points / max) you can show a client.
// This is distinct from the AI's qualitative read — these numbers are pure rules below.

const lc = (s) => String(s || "").toLowerCase();
const has = (v) => String(v || "").trim().length > 0;
const any = (text, list) => list.some((k) => text.includes(k));

// ── Keyword sets (the rules, exposed so they can be documented/explained) ──
export const ICP_SECTORS = ["restoration", "remediation", "mitigation", "water damage", "fire damage", "mold", "disaster", "construction", "contractor", "builder", "roofing", "hvac", "plumbing", "property", "renovation", "cleanup", "damage", "puroclean", "servpro", "rainbow", "1-800 water"];
const SERVICES_HINT = [...ICP_SECTORS, "services", "repair", "claims", "insurance", "franchise"];
const SENIOR_HIGH = ["owner", "founder", "co-founder", "cofounder", "ceo", "chief executive", "president", "principal", "proprietor", "partner", "managing director"];
const SENIOR_MID = ["director", "vice president", "vp", "head of", "general manager", "operations manager", "office manager", "manager", "lead"];
const NEED = ["estimat", "xactimate", "symbility", "admin", "office", "bookkeep", "account", "billing", "invoic", "ar/ap", "payroll", "schedul", "coordinat", "operation", "back office", "back-office", "customer success", "sales", "marketing", "claims"];
const SIGNALS = ["hir", "expand", "growth", "growing", "grew", "new office", "opened", "funding", "raised", "raise", "acqui", "storm", "season", "busy", "backlog", "scal", "added", "launch", "onboard", "recruit"];

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const sum = (f) => f.reduce((a, x) => a + x.points, 0);
const lc1 = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function pack(factors, confidence) {
  const score = clamp(sum(factors));
  const top = factors.filter((f) => f.points > 0).sort((a, b) => b.points - a.points)[0];
  const why = score >= 65 ? "Strong: " + lc1(top ? top.label.replace(/\s*\(.*\)/, "") : "good data fit") + "."
    : score >= 40 ? "Moderate, partial signals so far."
      : "Limited data, add more to raise this.";
  return { score, confidence, why, factors };
}
function confFrom(p, keys) {
  const n = keys.filter((k) => has(p[k])).length;
  return n >= 3 ? "high" : n === 2 ? "medium" : "low";
}

// Returns { icp, qualification, readiness, overall }, each dimension = { score, confidence, why, factors[] }.
export function scoreFit(p = {}) {
  const industry = lc(p.industry);
  const company = lc(p.company) + " " + lc(p.companyDesc);
  const title = lc(p.title) + " " + lc(p.headline);
  const blob = [industry, company, title, lc(p.about), lc(p.experience)].join(" ");

  // ICP Fit — does the COMPANY match our ideal customer?
  const icpF = [
    { label: "Target industry (restoration / construction / property)", points: any(industry, ICP_SECTORS) ? 50 : any(blob, ICP_SECTORS) ? 35 : 0, max: 50 },
    { label: "Operates as a field-services business", points: has(p.company) && any(company, SERVICES_HINT) ? 30 : has(p.company) ? 14 : 0, max: 30 },
    { label: "Role sits in the sector", points: any(title, ICP_SECTORS) || any(title, NEED) ? 20 : 0, max: 20 },
  ];

  // Qualification — is this PERSON a good lead?
  let sen = 0, senLabel = "";
  if (any(title, SENIOR_HIGH)) { sen = 50; senLabel = "owner / executive"; }
  else if (any(title, SENIOR_MID)) { sen = 35; senLabel = "director / manager"; }
  else if (has(p.title)) { sen = 15; senLabel = "individual contributor"; }
  const qF = [
    { label: "Decision-maker seniority" + (senLabel ? " (" + senLabel + ")" : ""), points: sen, max: 50 },
    { label: "Role needs our services (estimating / admin / finance / ops)", points: any(blob, NEED) ? 30 : 0, max: 30 },
    { label: "Identified company / account", points: has(p.company) ? 20 : 0, max: 20 },
  ];

  // Buying readiness — are they likely to act NOW?
  const news = lc(p.news);
  let pressure = 0;
  [p.growth, p.staffing, p.ops].forEach((v) => { if (has(v)) pressure += 12; });
  const rF = [
    { label: "Recent buying signals (hiring, expansion, storm season…)", points: has(news) ? (any(news, SIGNALS) ? 45 : 30) : 0, max: 45 },
    { label: "Stated growth / staffing / operational pressure", points: Math.min(35, pressure), max: 35 },
    { label: "Known pain points", points: has(p.pain) ? 20 : 0, max: 20 },
  ];

  const icp = pack(icpF, confFrom(p, ["industry", "company", "companyDesc", "headline"]));
  const qualification = pack(qF, confFrom(p, ["title", "company", "about", "experience"]));
  const readiness = pack(rF, confFrom(p, ["news", "growth", "staffing", "ops", "pain"]));
  return { icp, qualification, readiness, overall: Math.round((icp.score + qualification.score + readiness.score) / 3) };
}
