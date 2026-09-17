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

const USAGE = `Usage:
  node scripts/zoho-token.mjs --id <client id> --secret <client secret> --code <grant code> [--dc com|eu|in|com.au|jp|ca]

Get all three from https://api-console.zoho.com:
  1. Add Client -> Self Client -> Create   (or open the one already there)
  2. Client Secret tab   -> the id and the secret
  3. Generate Code tab   -> scope "ZohoVoice.sdk.READ", pick a duration, Create
                         -> the code (it expires in minutes; use it now)`;

/* Catch the placeholders from the instructions being pasted verbatim. Zoho
   answers those with "invalid_client", which sends people hunting for a wrong
   data centre or a mistyped secret instead of the actual cause. */
const isPlaceholder = (v) =>
  /^(YOUR_|<|\[)|_CLIENT_ID$|_CLIENT_SECRET$|^CODE$/i.test(String(v || ""));

function fail(message) {
  console.error(message);
  /* Not process.exit(): exiting while fetch still holds a socket trips a libuv
     assertion on Windows (UV_HANDLE_CLOSING) that looks like a crash on top of
     whatever the real error was. Setting the code lets Node close cleanly. */
  process.exitCode = 1;
}

async function main() {
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

  if (!id || !secret || !code) return fail(USAGE);

  const res = await fetch(`https://accounts.zoho.${dc}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: id,
      client_secret: secret,
      code,
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
}

main().catch((e) => fail("\nCould not reach Zoho: " + e.message));
