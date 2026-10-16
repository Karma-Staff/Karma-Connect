"use strict";
/* electron-builder configuration for the Karma Connect Dialer (Windows).

   Kept in JS rather than package.json so signing switches on only when its
   credentials are present: a laptop build without them is unsigned (fine for
   testing), and CI with them signs every executable — the app, elevate.exe,
   the installer and the uninstaller — through Microsoft Artifact Signing
   (formerly Trusted Signing). The Azure login itself comes from the standard
   AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET variables.

   Set these to sign:
     KC_SIGN_ENDPOINT      e.g. https://eus.codesigning.azure.net
     KC_SIGN_ACCOUNT       the Artifact Signing account name
     KC_SIGN_PROFILE       the certificate profile name
     KC_SIGN_PUBLISHER     the publisher name exactly as on the certificate
                           (e.g. "Karma Staff LLC") — the updater refuses an
                           update signed by anyone else */

/* All four or none. The publisher name is not optional: without it
   app-update.yml has no publisherName and electron-updater skips the
   same-publisher check on updates — a signed build that accepts unsigned
   updates. Half a configuration fails the build rather than ship that. */
const SIGN_VARS = ["KC_SIGN_ENDPOINT", "KC_SIGN_ACCOUNT", "KC_SIGN_PROFILE", "KC_SIGN_PUBLISHER"];
const signSet = SIGN_VARS.filter((k) => process.env[k]);
if (signSet.length && signSet.length !== SIGN_VARS.length)
  throw new Error("Code signing is half-configured — missing: " + SIGN_VARS.filter((k) => !process.env[k]).join(", "));
const sign = signSet.length === SIGN_VARS.length;

module.exports = {
  appId: "com.karmastaff.karmaconnect.dialer",
  productName: "Karma Connect Dialer",
  icon: "icons/icon.png",
  files: ["main.js", "dialer-preload.js", "bubble.html", "bubble-preload.js", "icons/**"],

  /* Electron fuses — flipped in the binary at package time. An installed copy
     cannot be used as a general-purpose Node.js runner (ELECTRON_RUN_AS_NODE,
     NODE_OPTIONS, --inspect), only loads the app.asar it shipped with and
     checks that file against the hash embedded at build time, and encrypts
     its cookie store (the signed-in session) with Windows DPAPI. */
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
    grantFileProtocolExtraPrivileges: false,
  },

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    // a release must never go out half-signed: if signing is configured, it is required
    forceCodeSigning: !!sign,
    verifyUpdateCodeSignature: true,
    ...(sign ? {
      azureSignOptions: {
        endpoint: process.env.KC_SIGN_ENDPOINT,
        codeSigningAccountName: process.env.KC_SIGN_ACCOUNT,
        certificateProfileName: process.env.KC_SIGN_PROFILE,
        publisherName: process.env.KC_SIGN_PUBLISHER,
        fileDigest: "SHA256",
        timestampRfc3161: "http://timestamp.acs.microsoft.com",
        timestampDigest: "SHA256",
      },
    } : {}),
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    // shown as a page in the installer: what the app does on this PC
    license: "install-notice.txt",
    // the profile holds the signed-in session; an uninstall should not leave it behind
    deleteAppDataOnUninstall: true,
  },

  /* Updates: the installer, latest.yml (with its sha512) and the blockmap go to
     a GitHub Release tagged desktop-vX.Y.Z; installed copies read the newest
     non-prerelease from there. */
  publish: [{
    provider: "github",
    owner: "Karma-Staff",
    repo: "Karma-Connect",
    tagNamePrefix: "desktop-v",
    releaseType: "draft",
  }],
};
