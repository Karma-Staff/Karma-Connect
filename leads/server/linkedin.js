"use strict";
/* LinkedIn facts for the prospect briefing, via Apify.

   Why Apify and not our own scraper: this server runs on Render. LinkedIn
   wants a signed-in session, and a datacenter IP without one gets a login
   wall on the first request. The agent/ folder scrapes LinkedIn properly,
   but only because it runs on a rep's own machine with a browser they
   signed into by hand — that cannot be a button on a hosted page. Apify
   runs the scrape on their infrastructure and hands back JSON, which is the
   same arrangement the job search already uses.

   THE ACTOR IS NOT HARD-CODED. Apify's LinkedIn actors come and go, change
   id, and return quite different shapes, and picking one here that happens
   to 404 for you would be worse than asking. Set the actor id from the
   Apify store:

     APIFY_LINKEDIN_COMPANY_ACTOR   used for a company row
     APIFY_LINKEDIN_PROFILE_ACTOR   used for a person row (optional)

   Once the actor is set, check it against one company before trusting a
   briefing built on it — it prints the raw item beside what we extracted,
   which is the whole of what the model will be told:

     node leads/server/linkedin.js "SERVPRO of Tulsa"
     node leads/server/linkedin.js --person "Dana Reed"
     node leads/server/linkedin.js --raw "Acme"      full item, unabridged

   Which is also why everything below reads the result defensively: field
   names are guesses across several popular actors, and anything unknown is
   dropped rather than shown. If your actor returns something we ignore, the
   raw item is available in the run log and the mapping is a one-line
   addition to PICK. */

const { apify } = require("./apify");

const COMPANY_ACTOR = (process.env.APIFY_LINKEDIN_COMPANY_ACTOR || "").trim();
const PROFILE_ACTOR = (process.env.APIFY_LINKEDIN_PROFILE_ACTOR || "").trim();
/* Apify charges per run and per dataset item. One prospect is one item, and
   a runaway actor that returns 500 rows for a bad query would be billed. */
const MAX_ITEMS = 3;
const TIMEOUT_SEC = 120;

const configured = () => !!COMPANY_ACTOR;

/* Actors disagree about names for the same fact. Each entry is the list of
   keys seen in the wild, first match wins. Adding an actor means adding its
   spelling here, not branching on which actor is configured. */
const PICK = {
  name: ["name", "companyName", "title", "fullName", "full_name"],
  description: ["description", "about", "summary", "tagline", "headline", "companyDescription"],
  industry: ["industry", "industryName", "industries", "sector"],
  size: ["companySize", "employeeCount", "employeesCount", "staffCount", "size", "employees"],
  location: ["location", "headquarters", "hq", "addressWithCountry", "geoLocationName", "city"],
  website: ["website", "websiteUrl", "companyWebsite", "url"],
  founded: ["founded", "foundedOn", "yearFounded", "foundedYear"],
  specialties: ["specialties", "services", "skills"],
  followers: ["followers", "followerCount", "followersCount"],
  headline: ["headline", "occupation", "subTitle"],
  jobTitle: ["jobTitle", "position", "currentPosition", "title"],
  education: ["education", "schools", "educations"],
  experience: ["experience", "positions", "experiences"],
  posts: ["posts", "updates", "recentPosts", "activity"],
};

const isEmptyish = (v) => v === null || v === undefined || v === ""
  || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

function pick(item, field) {
  for (const key of PICK[field] || []) {
    const v = item[key];
    if (!isEmptyish(v)) return v;
  }
  return null;
}

/* Everything the model is shown must be a plain string. Actors return
   strings, numbers, arrays of strings and arrays of objects for the same
   field depending on the day, and an "[object Object]" in a briefing is a
   fact a rep cannot check. */
function flatten(v, depth = 0) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (depth > 1) return "";
    return v.map((x) => flatten(x, depth + 1)).filter(Boolean).slice(0, 6).join("; ");
  }
  if (typeof v === "object") {
    if (depth > 1) return "";
    // the fields that carry the meaning in a nested education/experience entry
    const parts = ["title", "name", "schoolName", "school", "companyName",
      "degreeName", "fieldOfStudy", "subtitle", "caption", "text", "dateRange"]
      .map((k) => (typeof v[k] === "string" ? v[k].trim() : ""))
      .filter(Boolean);
    return parts.length ? parts.join(" — ") : "";
  }
  return "";
}

/* Turn a dataset item into the labelled lines the briefing prompt reads.
   Exported and pure, so linkedin.test.js can throw real actor shapes at it. */
function factsFrom(items, kind) {
  const rows = Array.isArray(items) ? items.filter((x) => x && typeof x === "object") : [];
  if (!rows.length) return "";
  const item = rows[0];

  const fields = kind === "person"
    ? ["name", "headline", "jobTitle", "location", "description", "education", "experience", "posts"]
    : ["name", "description", "industry", "size", "location", "website", "founded", "specialties", "followers", "posts"];

  const LABEL = {
    name: "Name", description: "About", industry: "Industry", size: "Company size",
    location: "Location", website: "Website", founded: "Founded",
    specialties: "Specialties", followers: "LinkedIn followers",
    headline: "Headline", jobTitle: "Current title",
    education: "Education", experience: "Experience", posts: "Recent LinkedIn activity",
  };

  const lines = [];
  for (const f of fields) {
    const text = flatten(pick(item, f));
    if (text) lines.push(LABEL[f] + ": " + text.slice(0, 600));
  }
  return lines.join("\n");
}

/* Run the actor and return the labelled facts, or "" when there is nothing.
   Never throws for a scrape that simply found nothing — that is an ordinary
   outcome and the caller degrades to what it already knew. */
async function scrape(lead) {
  const person = lead.kind === "person";
  const actor = person ? (PROFILE_ACTOR || COMPANY_ACTOR) : COMPANY_ACTOR;
  if (!actor) return { facts: "", actor: "", reason: "no actor configured" };

  /* Actors take wildly different inputs. These three cover the common
     shapes; an actor wanting something else ignores the keys it does not
     know, which is the failure we want (empty result, not a crash). */
  const query = [lead.company || lead.name, lead.city, lead.state]
    .filter(Boolean).join(" ").trim();
  const input = {
    queries: [query], search: query, keyword: query,
    ...(lead.website ? { urls: [lead.website], startUrls: [{ url: lead.website }] } : {}),
    maxItems: MAX_ITEMS, limit: MAX_ITEMS,
  };

  try {
    const items = await apify(
      `/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items`
      + `?timeout=${TIMEOUT_SEC}&format=json&clean=true&maxItems=${MAX_ITEMS}`,
      { method: "POST", body: JSON.stringify(input) });
    return { facts: factsFrom(items, person ? "person" : "company"), actor,
      count: Array.isArray(items) ? items.length : 0 };
  } catch (e) {
    /* A failed scrape must not fail the briefing. Say so in the log, hand
       back nothing, and let the caller decide. */
    console.warn("[karma] linkedin scrape failed:", e.message.slice(0, 200));
    return { facts: "", actor, reason: e.message.slice(0, 200) };
  }
}

/* Run the configured actor against one name and show both what came back
   and what we made of it. This exists because the field mapping above is a
   guess until a real actor answers: the two panels side by side say
   immediately whether PICK needs another spelling adding. */
async function check(argv) {
  const raw = argv.includes("--raw");
  const person = argv.includes("--person");
  const name = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!name) {
    console.error('usage: node leads/server/linkedin.js [--person] [--raw] "<company or person>"');
    process.exitCode = 1;
    return;
  }
  const actor = person ? (PROFILE_ACTOR || COMPANY_ACTOR) : COMPANY_ACTOR;
  if (!actor) {
    console.error("No actor configured. Set APIFY_LINKEDIN_COMPANY_ACTOR"
      + (person ? " (or APIFY_LINKEDIN_PROFILE_ACTOR)" : "") + " and try again.");
    process.exitCode = 1;
    return;
  }
  console.log(`actor : ${actor}`);
  console.log(`query : ${name}${person ? "  (person)" : "  (company)"}\n`);

  const lead = person ? { kind: "person", name } : { kind: "company", company: name };
  const out = await scrape(lead);

  if (out.reason) {
    console.error("the scrape did not return anything:", out.reason);
    process.exitCode = 1;
    return;
  }
  console.log(`items returned: ${out.count}\n`);
  console.log("── what the briefing will be told ──");
  console.log(out.facts || "(nothing — every field we look for was missing)");
  if (!out.facts)
    console.log("\nThe actor answered but none of its field names match PICK in this file."
      + " Re-run with --raw and add the spellings it uses.");
  if (raw) {
    console.log("\n── raw first item ──");
    const items = await apify(
      `/acts/${encodeURIComponent(actor)}/runs/last/dataset/items?format=json&clean=true&limit=1`);
    console.log(JSON.stringify(items && items[0], null, 2));
  } else {
    console.log("\n(--raw shows the actor's own item, if a field is missing)");
  }
}

module.exports = { scrape, factsFrom, flatten, configured, check, COMPANY_ACTOR, PROFILE_ACTOR };

/* Only when run directly — never when the server requires this. */
if (require.main === module) {
  check(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
