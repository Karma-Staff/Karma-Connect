// Packages the local LinkedIn agent as a zip the user downloads from the app, so running it
// never requires GitHub access or a clone. Built in memory on request: the payload is ~35 KB
// of text, so there's nothing worth caching or writing to disk.
//
// The file list is an explicit ALLOWLIST, never a directory walk. agent/.profile/ holds a LIVE
// logged-in LinkedIn session — a walk that ever picked it up would ship one user's session to
// whoever clicked Download. Naming the files makes that leak impossible by construction.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const AGENT_DIR = path.join(__dirname, "..", "agent");
const FILES = ["README.md", "run.cjs", "scrape.cjs", "send.cjs", "session.cjs", "invite.cjs", "inbox.cjs", "capture.cjs"];
const ROOT = "karma-connect-agent"; // everything sits under one folder, so unzipping is tidy

// ── Minimal zip writer (deflate) ──────────────────────────────────────────────
// A zip is [local header + data] per entry, then a central directory, then the EOCD record.
// Writing it by hand keeps the server dependency-free; archiver/jszip would be ~1 MB for this.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// DOS timestamp: 2-second resolution, epoch 1980. Zip has no other portable time field.
function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

function zip(entries) {
  const now = new Date();
  const time = dosTime(now);
  const date = dosDate(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data);
    // Deflate can exceed the input on tiny or incompressible files; fall back to stored.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0o644 << 16, 38); // external attrs: regular file, rw-r--r--
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk holding the central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment len
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ── Generated files ───────────────────────────────────────────────────────────
// Standalone: the download is its own npm project, so playwright is a real dependency here
// (in the main repo it's optional, to keep it off the Render build) and the scripts point at
// run.cjs in the same folder rather than agent/run.cjs.
function packageJson({ baseUrl }) {
  return (
    JSON.stringify(
      {
        name: "karma-connect-agent",
        version: "1.0.0",
        private: true,
        description: "Local LinkedIn worker for Karma Connect — sends the messages you approved in the app.",
        scripts: {
          pair: "node run.cjs --url " + baseUrl + " --pair",
          login: "node run.cjs --login",
          start: "node run.cjs",
          "dry-run": "node run.cjs --dry-run",
        },
        dependencies: { playwright: "^1.49.0" },
      },
      null,
      2,
    ) + "\n"
  );
}

// Prefilled with the caller's own server URL. No password goes anywhere: the PC is paired with a
// one-time code from the LinkedIn agent page, and keeps a device token that only the agent's own
// endpoints accept.
function setupMd({ baseUrl }) {
  const F = "```"; // fence, kept out of the template literal below

  return `# Run the Karma Connect LinkedIn agent

This agent runs on **your machine**, not on the server. It opens your signed-in browser and does
the LinkedIn work you approved in Karma Connect: connection requests with your note, messages
(a follow-up waits until they accept), and replies. Between sends it reads your inbox for replies
from prospects, so AI can draft an answer in the Send Queue for you to approve.

Once it's set up, you control everything from Karma Connect → **LinkedIn agent**: start and
pause, dry run, daily limits and hours, "check the inbox now", and signing in to LinkedIn.

Your server: **${baseUrl}**

## 1. Install

You need [Node.js 20+](https://nodejs.org). Then, in this folder:

${F}bash
npm install
${F}

## 2. Connect this PC

In Karma Connect open **LinkedIn agent → Connect a PC**. It shows a code like \`K7Q4-MZ2P\`
(valid 15 minutes). Then here:

${F}bash
npm run pair -- K7Q4-MZ2P
${F}

On Windows that's all: the agent starts in the background now and every time Windows starts.
On macOS / Linux, run \`npm start\` and leave the window open.

## 3. Sign in to LinkedIn

On the LinkedIn agent page press **Sign in to LinkedIn**. Edge opens on this PC: sign in with your
LinkedIn **email and password**, not "Continue with Google", which refuses automated browsers.
The window closes itself when you're done, and the session is reused for weeks.

Running more than one LinkedIn account (up to four)? Press **Add a LinkedIn account** on that page,
then **Sign in to LinkedIn** on the new account. Each one gets its own browser window on this PC.

## 4. Try it, then run it

Turn on **Dry run** on the LinkedIn agent page and press **Start**. The agent opens each profile,
presses Connect or Message, types the note or message, then clears it: nothing is sent. The
activity log on that page shows every step. Turn Dry run off when you're happy.

## Notes

- Approve messages in the app first. The agent only sends what a human approved, and it never
  writes or edits message content. Replies are drafted by AI in the app and still need your OK.
- It only reports conversations with people you reached out to from Karma Connect. Everything
  else in your LinkedIn inbox stays on this machine.
- \`.profile/\` holds a **live logged-in LinkedIn session**, and \`.kc-agent.json\` this PC's
  key to Karma Connect. Don't copy either to another machine. To cut a PC off, press
  **Disconnect** next to it on the LinkedIn agent page.
- \`agent.log\` is the log on this PC. \`README.md\` is the full reference.
`;
}

// Builds the zip. Throws if the agent sources are missing from the deploy.
function buildAgentZip({ baseUrl }) {
  const entries = FILES.map((name) => ({
    name: ROOT + "/" + name,
    data: fs.readFileSync(path.join(AGENT_DIR, name)),
  }));
  entries.unshift({ name: ROOT + "/SETUP.md", data: Buffer.from(setupMd({ baseUrl }), "utf8") });
  entries.push({ name: ROOT + "/package.json", data: Buffer.from(packageJson({ baseUrl }), "utf8") });
  return zip(entries);
}

module.exports = { buildAgentZip };
