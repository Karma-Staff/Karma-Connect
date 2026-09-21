"use strict";
/* The Apify client: where the token comes from, and one fetch wrapper.

   Lifted out of jobsearch.js when a second caller appeared (the LinkedIn
   scrape behind prospect research). Two copies would have meant two places
   that resolve the token and two different error messages for the same
   missing setting. */

const fs = require("fs");
const path = require("path");

const APIFY = "https://api.apify.com/v2";

function apifyToken() {
  const env = (process.env.APIFY_TOKEN || "").trim();
  if (env) return env;
  const p = path.join(__dirname, "..", "apify_token.json");
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8").replace(/^﻿/, "");
  } catch {
    // on a hosted box there is no token file — say what to actually do
    throw new Error("Apify token not configured — set the APIFY_TOKEN "
      + "environment variable (or apify_token.json beside the repo in dev)");
  }
  const t = JSON.parse(raw).token;
  if (!t) throw new Error("apify_token.json has no \"token\" field");
  return t;
}

async function apify(pathname, opts = {}) {
  const res = await fetch(APIFY + pathname, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apifyToken(),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Apify ${pathname.split("?")[0]} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

module.exports = { APIFY, apify, apifyToken };
