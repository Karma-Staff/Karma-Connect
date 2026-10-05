// Turn a Zoho Self Client grant code into a refresh token.
//
// Two uses now: the Voice softphone (--for voice, the default) and the CRM
// sync (--for crm). Same exchange, different scope chosen in the console and a
// different variable name printed at the end, so the two tokens cannot be
// pasted into each other's slot.
//
// The grant code from the API console expires in minutes and can only be
// exchanged once, so this exists to make that exchange a single command rather
// than a hand-typed curl with four query parameters and a data-centre domain
// that is easy to get wrong.
//
//   node scripts/zoho-token.mjs --for crm --code 1000.yyy
//   node scripts/zoho-token.mjs --id 1000.XXXX --secret abc123 --code 1000.yyy
//   node scripts/zoho-token.mjs ... --dc eu        # .com (default), eu, in, com.au, jp, ca
//
// Prints the .env lines to paste. Nothing is written to disk and nothing is
// logged anywhere — the secret and the token only ever exist in your terminal.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : null;
};

/* The id and secret fall back to .env, because the CRM token is minted from
   the SAME Self Client as the Voice one — so they are already sitting there,
   and copying them again is two more chances to paste the wrong thing. Only
   the grant code has to be typed, and that is the one that cannot be stored
   because it expires in minutes. */
function fromEnvFile(name) {
  try {
    const txt = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const line = txt.split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .find((l) => l.startsWith(name + "="));
    return line ? line.slice(name.length + 1).trim() : null;
  } catch { return null; }
}

const id = arg("id") || process.env.ZOHO_CLIENT_ID || fromEnvFile("ZOHO_CLIENT_ID");
const secret = arg("secret") || process.env.ZOHO_CLIENT_SECRET || fromEnvFile("ZOHO_CLIENT_SECRET");
const code = arg("code");
const dc = (arg("dc") || "com").replace(/^\./, "");
const forWhat = (arg("for") || "voice").toLowerCase();

const SCOPES = {
  voice: "ZohoVoice.sdk.ALL",
  crm: "ZohoCRM.modules.ALL,ZohoCRM.settings.modules.READ,"
    + "ZohoCRM.settings.fields.READ,ZohoCRM.coql.READ",
};

const USAGE = `Usage:
  node scripts/zoho-token.mjs --for crm --code <grant code>
  node scripts/zoho-token.mjs --for voice --code <grant code>

  --id and --secret are read from .env (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET)
  unless you pass them. --dc defaults to com (eu, in, com.au, jp, ca).

At https://api-console.zoho.com:
  1. Add Client -> Self Client -> Create   (or open the one already there)
  2. Client Secret tab   -> the id and the secret, if you need them
  3. Generate Code tab   -> paste the SCOPE for what you are setting up:

       --for voice   ${SCOPES.voice}
                     (ALL, not READ: a read-only token dials fine and then
                      fails with "Invalid OAuth scope" the moment the softphone
                      saves a disposition or a note)

       --for crm     ${SCOPES.crm}
                     (modules to write Accounts/Contacts/Calls/Notes; settings
                      to read the field names before mapping onto them; coql to
                      look for an existing record rather than making a second)

                         -> pick a duration, Create
                         -> the code (it expires in minutes; use it now)

A token carries the scope it was minted with, for good. A Voice token can
never reach the CRM, and changing which variable it sits in does not change
that — mint a second one.`;

/* Catch the placeholders from the instructions being pasted verbatim. Zoho
   answers those with "invalid_client", which sends people hunting for a wrong
   data centre or a mistyped secret instead of the actual cause. */
const isPlaceholder = (v) =>
  /^(YOUR_|<|\[)|_CLIENT_ID$|_CLIENT_SECRET$|^CODE$/i.test(String(v || ""));

/* Read the grant code from the terminal. Printed instructions first, so the
   person can start this, go to the Zoho console, and come back — the waiting
   is the point. */
function askForCode() {
  return new Promise((resolve) => {
    process.stdout.write(`
Ready. Now go and generate the code — this will wait.

  1. https://api-console.zoho.com  ->  your Self Client  ->  Generate Code
  2. Scope:

     ${SCOPES[forWhat]}

  3. Pick a duration, Create, choose your CRM portal, copy the code.

Paste the code here and press Enter:
> `);
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      process.stdin.pause();
      resolve(buf.slice(0, nl).trim());
    });
  });
}

function fail(message) {
  console.error(message);
  /* Not process.exit(): exiting while fetch still holds a socket trips a libuv
     assertion on Windows (UV_HANDLE_CLOSING) that looks like a crash on top of
     whatever the real error was. Setting the code lets Node close cleanly. */
  process.exitCode = 1;
}

async function main() {
  if (!["voice", "crm"].includes(forWhat))
    return fail(`\n--for must be "voice" or "crm", not "${forWhat}".\n` + USAGE);

  if ([id, secret, code].some((v) => v && isPlaceholder(v))) {
    return fail(`
Those are still the example values, not your own.

  --id      looks like  1000.ABCD1234EFGH5678IJKL9012MNOP3456
  --secret  looks like  9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928
  --code    looks like  1000.abc123...def456

Both the id and the secret are on the Self Client's "Client Secret" tab at
https://api-console.zoho.com — copy each one and paste it in place of
YOUR_CLIENT_ID and YOUR_CLIENT_SECRET.`);
  }

  if (!id || !secret) {
    const missing = [!id && "client id", !secret && "client secret"]
      .filter(Boolean).join(", ");
    return fail(`\nMissing: ${missing}\n\n` + USAGE);
  }

  /* No --code? Wait for one to be pasted.
     A Zoho grant code lives about three minutes and can be used once, and the
     old shape of this command lost that race every time: generate the code,
     then go and find the right folder, then paste — and by then it is dead,
     and Zoho says "invalid_code" without mentioning the clock. Starting the
     script first and pasting into it removes the race rather than asking
     anyone to hurry. */
  const grant = code || await askForCode();
  if (!grant) return fail("\nNo code given.\n\n" + USAGE);

  const res = await fetch(`https://accounts.zoho.${dc}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: id,
      client_secret: secret,
      code: grant,
    }),
  });
  const data = await res.json().catch(() => ({}));

  /* Zoho reports failures with HTTP 200 and an `error` field, so the status
     code alone cannot tell success from failure. */
  if (!res.ok || data.error || !data.refresh_token) {
    const hint = {
      invalid_code: "the code expired or was already used — generate a fresh one",
      invalid_client: "check the id and secret are your real ones, copied from the "
        + "Client Secret tab, and that this account is on ." + dc,
      invalid_client_secret: "the secret is wrong",
    }[data.error];
    return fail(`
Zoho refused the exchange: ${data.error || `HTTP ${res.status}`}`
      + (hint ? `\n  ${hint}` : "")
      + (!data.error && !data.refresh_token
        ? "\n  no refresh_token in the reply — a Self Client code is single-use"
        : "")
      + `\n\nfull reply: ${JSON.stringify(data, null, 2)}`);
  }

  /* Say what scope actually came back. Asking for CRM and being handed a Voice
     token — because the console still had the old scope in the box — is the
     failure that otherwise shows up much later as a permission error. */
  const got = String(data.scope || "");
  const wantsCrm = forWhat === "crm";
  const mismatch = wantsCrm ? !/ZohoCRM/i.test(got) : !/ZohoVoice/i.test(got);

  console.log(`
Done. Scope granted: ${got || "(not reported)"}
${mismatch ? `
WARNING: you asked for --for ${forWhat} but that scope is not in the grant.
The scope comes from the box in the Generate Code tab, not from this command.
Generate a fresh code with:

  ${SCOPES[forWhat]}
` : ""}
Put these in .env (and in Render's environment for the deploy):

${wantsCrm ? `ZOHO_CRM_CLIENT_ID=${id}
ZOHO_CRM_CLIENT_SECRET=${secret}
ZOHO_CRM_REFRESH_TOKEN=${data.refresh_token}` : `ZOHO_VOICE_ENABLED=1
ZOHO_DIAL_MODE=sdk
ZOHO_CLIENT_ID=${id}
ZOHO_CLIENT_SECRET=${secret}
ZOHO_REFRESH_TOKEN=${data.refresh_token}`}${dc === "com" ? "" : `
ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.${dc}`}

The refresh token does not expire, so keep it like a password: it is a durable
key to ${wantsCrm ? "your CRM data" : "the phone account"}. Never commit it —
.env is gitignored.
`);
}

main().catch((e) => fail("\nCould not reach Zoho: " + e.message));
