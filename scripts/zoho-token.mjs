// Turn a Zoho Self Client grant code into the refresh token server/voice.js needs.
//
// The grant code from the API console expires in minutes and can only be
// exchanged once, so this exists to make that exchange a single command rather
// than a hand-typed curl with four query parameters and a data-centre domain
// that is easy to get wrong.
//
//   node scripts/zoho-token.mjs --id 1000.XXXX --secret abc123 --code 1000.yyy
//   node scripts/zoho-token.mjs ... --dc eu        # .com (default), eu, in, com.au, jp, ca
//
// Prints the .env lines to paste. Nothing is written to disk and nothing is
// logged anywhere — the secret and the token only ever exist in your terminal.

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : null;
};

const id = arg("id");
const secret = arg("secret");
const code = arg("code");
const dc = (arg("dc") || "com").replace(/^\./, "");

if (!id || !secret || !code) {
  console.error(`Usage:
  node scripts/zoho-token.mjs --id <client id> --secret <client secret> --code <grant code> [--dc com|eu|in|com.au|jp|ca]

Get all three from https://api-console.zoho.com:
  1. Add Client -> Self Client -> Create
  2. Client Secret tab   -> the id and the secret
  3. Generate Code tab   -> scope "ZohoVoice.sdk.READ", pick a duration, Create
                         -> the code (it expires in minutes; use it now)`);
  process.exit(1);
}

const url = `https://accounts.zoho.${dc}/oauth/v2/token`;
const body = new URLSearchParams({
  grant_type: "authorization_code",
  client_id: id,
  client_secret: secret,
  code,
});

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body,
});
const data = await res.json().catch(() => ({}));

/* Zoho answers failures with HTTP 200 and an `error` field, so the status code
   alone is not enough to tell success from failure. */
if (!res.ok || data.error || !data.refresh_token) {
  console.error("\nZoho refused the exchange:", data.error || `HTTP ${res.status}`);
  const hint = {
    invalid_code: "the code expired or was already used — generate a fresh one",
    invalid_client: "client id/secret do not match, or belong to another data centre",
    invalid_client_secret: "the secret is wrong",
    "Invalid Redirect Uri": "this client is not a Self Client — create one of those instead",
  }[data.error];
  if (hint) console.error("  " + hint);
  if (!data.refresh_token && !data.error) {
    console.error("  no refresh_token in the reply — a Self Client grant code is single-use");
  }
  console.error("\nfull reply:", JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log(`
Done. Put these in .env (and in Render's environment for the deploy):

ZOHO_VOICE_ENABLED=1
ZOHO_DIAL_MODE=sdk
ZOHO_CLIENT_ID=${id}
ZOHO_CLIENT_SECRET=${secret}
ZOHO_REFRESH_TOKEN=${data.refresh_token}${dc === "com" ? "" : `
ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.${dc}`}

The refresh token does not expire, so keep it like a password: it is a durable
key to the phone account. Never commit it — .env is gitignored.
`);
