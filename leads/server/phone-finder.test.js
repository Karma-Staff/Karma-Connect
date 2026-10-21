import { describe, it, expect } from "vitest";
import { createRequire } from "module";

// phone-finder.js requires db.js, which refuses to load without a connection string. Nothing here
// queries; a dummy URL lets the module load and the lazy pg Pool never connects.
process.env.DATABASE_URL ||= "postgres://u:p@localhost:5432/test";
const require = createRequire(import.meta.url);
const { _test } = require("./phone-finder.js");
const { phonesFromHtml, bestPhone, isPrivateIp, verifiedByCitations, fmt } = _test;

describe("reading a phone number off a company's page", () => {
  it("prefers a tel: link over numbers in the text", () => {
    const html = `<header><a href="tel:+1-512-555-0187">Call us</a></header>
      <p>Office (512) 555-0101 · (512) 555-0101 · (512) 555-0101</p>`;
    expect(bestPhone(phonesFromHtml(html))).toBe("5125550187");
  });

  it("takes the number printed most often when there's no tel: link", () => {
    const html = `<p>Call 512.555.0101</p><footer>512-555-0101 · Careers 512 555 0199</footer>`;
    expect(bestPhone(phonesFromHtml(html))).toBe("5125550101");
  });

  it("skips a fax number", () => {
    const html = `<p>Fax: (512) 555-0177</p><p>Phone (512) 555-0123</p>`;
    expect(phonesFromHtml(html).map((p) => p.key)).toEqual(["5125550123"]);
  });

  it("ignores scripts, styles and numbers that can't be a phone", () => {
    const html = `<script>var id = "5125550111";</script><style>.a{width:5125550112px}</style>
      <p>Order #1234567890 · Since 1999 · (011) 555-0100</p>`;
    expect(phonesFromHtml(html)).toEqual([]);
  });

  it("formats what it writes the way the lead base does", () => {
    expect(fmt("5125550187")).toBe("(512) 555-0187");
  });
});

describe("never reading a private address", () => {
  it("refuses internal networks and loopback", () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "172.16.4.1", "172.31.255.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
      expect(isPrivateIp(ip), ip).toBe(true);
  });
  it("allows public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe("a Google Maps place is used only when it's plainly this business", () => {
  const { sameBusiness, sameTown, mapsQuery } = _test;
  it("matches the same name, written differently", () => {
    expect(sameBusiness("Greenwood Industries, Inc.", "Greenwood Industries")).toBe(true);
    expect(sameBusiness("Ruiz Restoration", "Ruiz Restoration LLC")).toBe(true);
    expect(sameBusiness("A & B Water Damage", "A and B Water Damage")).toBe(true);
  });
  it("never gives one franchise branch's number to another", () => {
    expect(sameBusiness("SERVPRO of South Tampa", "SERVPRO of North Tampa")).toBe(false);
    expect(sameBusiness("Paul Davis Restoration of Austin", "Paul Davis Restoration of Dallas")).toBe(false);
  });
  it("refuses a different business", () => {
    expect(sameBusiness("Greenwood Industries", "Greenwood Plumbing")).toBe(false);
    expect(sameBusiness("Acme", "Zenith Roofing")).toBe(false);
  });
  it("needs the town to agree", () => {
    expect(sameTown({ city: "Worcester", state: "MA" }, { city: "Worcester", state: "Massachusetts" })).toBe(true);
    expect(sameTown({ city: "Worcester" }, { city: "Boston" })).toBe(false);
    expect(sameTown({ state: "Massachusetts" }, { state: "MA" })).toBe(true);
    expect(sameTown({ state: "TX" }, { state: "Oklahoma" })).toBe(false);
    expect(sameTown({}, { city: "Boston" })).toBe(false);
  });
  it("looks a person up by their company", () => {
    expect(mapsQuery({ kind: "person", name: "Jane Doe", company: "Ruiz Restoration", city: "Tampa", state: "FL" })).toBe("Ruiz Restoration, Tampa, FL");
    expect(mapsQuery({ kind: "job", name: "Estimator", company: "Greenwood Industries", city: "Worcester", state: "MA" })).toBe("Greenwood Industries, Worcester, MA");
  });
});

describe("a web search answer is kept only when the page says it", () => {
  const content = [
    { type: "text", text: "Their number is (512) 555-0187.", citations: [{ url: "https://acme.example/contact", cited_text: "Call Acme Restoration at 512-555-0187 today" }] },
  ];
  it("accepts a number that appears in the cited text", () => {
    expect(verifiedByCitations("5125550187", content)).toBe("https://acme.example/contact");
  });
  it("refuses a number the citations don't contain", () => {
    expect(verifiedByCitations("5125550999", content)).toBeNull();
    expect(verifiedByCitations("5125550187", [{ type: "text", text: "(512) 555-0187" }])).toBeNull();
  });
});
