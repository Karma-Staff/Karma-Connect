"use strict";
/* Area code -> US state / Canadian province, for "where are we calling".

   The US half is the table from dashboard/setup_and_import.py, which was
   validated there against the 6,019 leads carrying both a phone and a state
   (99.7% agree). Keep the two in step: change one, change both.

   The Canadian half is new and NOT validated against our data — the base is
   nearly all US, so there is nothing to check it against. 867 (all three
   territories) and 902/782 (shared by Nova Scotia and PEI) cannot name one
   region; 867 is left out and 902/782 count as Nova Scotia.

   Geography only: a mobile keeps its area code when its owner moves, so this
   says where a number was issued, not where the person is today. */

const US = {
  AL: "205 251 256 334 659 938", AK: "907", AZ: "480 520 602 623 928",
  AR: "327 479 501 870",
  CA: "209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 "
    + "628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 "
    + "925 949 951",
  CO: "303 719 720 970 983", CT: "203 475 860 959", DE: "302",
  DC: "202",
  FL: "239 305 321 324 352 386 407 448 561 656 689 727 754 772 786 813 850 "
    + "863 904 941 954",
  GA: "229 404 470 478 678 706 762 770 912 943", HI: "808", ID: "208 986",
  IL: "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 872",
  IN: "219 260 317 463 574 765 812 930", IA: "319 515 563 641 712",
  KS: "316 620 785 913", KY: "270 364 502 606 859",
  LA: "225 318 337 504 985", ME: "207", MD: "227 240 301 410 443 667",
  MA: "339 351 413 508 617 774 781 857 978",
  MI: "231 248 269 313 517 586 616 679 734 810 906 947 989",
  MN: "218 320 507 612 651 763 952", MS: "228 601 662 769",
  MO: "235 314 417 557 573 636 660 816", MT: "406", NE: "308 402 531",
  NV: "702 725 775", NH: "603",
  NJ: "201 551 609 640 732 848 856 862 908 973", NM: "505 575",
  NY: "212 315 332 347 363 516 518 585 607 631 646 680 716 718 838 845 914 "
    + "917 929 934",
  NC: "252 336 472 704 743 828 910 919 980 984", ND: "701",
  OH: "216 220 234 283 326 330 380 419 436 440 513 567 614 740 937",
  OK: "405 539 572 580 918", OR: "458 503 541 971",
  PA: "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878",
  RI: "401", SC: "803 821 839 843 854 864", SD: "605",
  TN: "423 615 629 731 865 901 931",
  TX: "210 214 254 281 325 346 361 367 409 430 432 469 512 682 713 726 737 "
    + "806 817 830 832 903 915 936 940 945 956 972 979",
  UT: "385 435 801", VT: "802",
  VA: "276 434 540 571 686 703 757 804 826 948",
  WA: "206 253 360 425 509 564", WV: "304 681",
  WI: "262 274 414 534 608 715 920", WY: "307",
};

const CA = {
  AB: "368 403 587 780 825", BC: "236 250 604 672 778", MB: "204 431 584",
  NB: "506", NL: "709", NS: "782 902",
  ON: "226 249 289 343 365 382 416 437 519 548 613 647 683 705 742 753 807 905",
  QC: "263 354 367 418 438 450 468 514 579 581 819 873",
  SK: "306 474 639",
};

const AREA_REGION = {};
for (const table of [US, CA])
  for (const [region, codes] of Object.entries(table))
    for (const code of codes.split(" ")) AREA_REGION[code] = region;

/* Region for a NANP number in any common shape ("+1 (512) 555-0142",
   "15125550142", "5125550142"). Toll-free and anything outside +1 give null. */
function regionOf(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10 || d[0] === "0" || d[0] === "1") return null;
  return AREA_REGION[d.slice(0, 3)] || null;
}

/* ---------------- country, for the world map ----------------

   Country calling code -> ISO 3166 alpha-2, matched longest-prefix-first.
   Where several countries share a code, the code goes to the largest of
   them; that is a rounding on a world map, not a claim about any number.

   +1 is split properly: Canadian area codes from the table above, the
   Caribbean NANP members below, everything else the US.

   Tibet is its own entry, matching the map, which draws all of it — Ü-Tsang,
   Kham and Amdo — as its own region. A +86 landline on a Tibetan area code
   counts as "TIB":
     Ü-Tsang  891 Lhasa · 892 Shigatse · 893 Lhoka · 894 Nyingchi ·
              895 Chamdo · 896 Nagchu · 897 Ngari
     Amdo     970 Tsojang (Haibei) · 971 Xining · 972 Haidong ·
              973 Malho (Huangnan) · 974 Tsolho (Hainan) · 975 Golog ·
              977 Tsonub (Haixi) · 941 Kanlho (Gannan) · 837 Ngawa
     Kham     976 Yushu · 836 Garzê · 887 Dechen
   This reads the area code of a landline; a mobile carries no place in it. */

const NANP_OTHER = {
  242: "BS", 246: "BB", 264: "AI", 268: "AG", 284: "VG", 340: "VI", 345: "KY",
  441: "BM", 473: "GD", 649: "TC", 658: "JM", 876: "JM", 664: "MS", 670: "MP",
  671: "GU", 684: "AS", 721: "SX", 758: "LC", 767: "DM", 784: "VC", 787: "PR",
  939: "PR", 809: "DO", 829: "DO", 849: "DO", 868: "TT", 869: "KN",
};

const CALLING = {
  7: "RU", 20: "EG", 27: "ZA", 30: "GR", 31: "NL", 32: "BE", 33: "FR", 34: "ES",
  36: "HU", 39: "IT", 40: "RO", 41: "CH", 43: "AT", 44: "GB", 45: "DK", 46: "SE",
  47: "NO", 48: "PL", 49: "DE", 51: "PE", 52: "MX", 53: "CU", 54: "AR", 55: "BR",
  56: "CL", 57: "CO", 58: "VE", 60: "MY", 61: "AU", 62: "ID", 63: "PH", 64: "NZ",
  65: "SG", 66: "TH", 81: "JP", 82: "KR", 84: "VN", 86: "CN", 90: "TR", 91: "IN",
  92: "PK", 93: "AF", 94: "LK", 95: "MM", 98: "IR",
  211: "SS", 212: "MA", 213: "DZ", 216: "TN", 218: "LY", 220: "GM", 221: "SN",
  223: "ML", 224: "GN", 225: "CI", 226: "BF", 227: "NE", 228: "TG", 229: "BJ",
  230: "MU", 231: "LR", 232: "SL", 233: "GH", 234: "NG", 235: "TD", 236: "CF",
  237: "CM", 238: "CV", 241: "GA", 242: "CG", 243: "CD", 244: "AO", 249: "SD",
  250: "RW", 251: "ET", 252: "SO", 253: "DJ", 254: "KE", 255: "TZ", 256: "UG",
  257: "BI", 258: "MZ", 260: "ZM", 261: "MG", 263: "ZW", 264: "NA", 265: "MW",
  266: "LS", 267: "BW", 268: "SZ", 291: "ER",
  351: "PT", 352: "LU", 353: "IE", 354: "IS", 355: "AL", 356: "MT", 357: "CY",
  358: "FI", 359: "BG", 370: "LT", 371: "LV", 372: "EE", 373: "MD", 374: "AM",
  375: "BY", 376: "AD", 377: "MC", 380: "UA", 381: "RS", 382: "ME", 383: "XK",
  385: "HR", 386: "SI", 387: "BA", 389: "MK", 420: "CZ", 421: "SK", 423: "LI",
  501: "BZ", 502: "GT", 503: "SV", 504: "HN", 505: "NI", 506: "CR", 507: "PA",
  509: "HT", 591: "BO", 592: "GY", 593: "EC", 595: "PY", 597: "SR", 598: "UY",
  670: "TL", 673: "BN", 675: "PG", 679: "FJ",
  850: "KP", 852: "HK", 853: "MO", 855: "KH", 856: "LA", 880: "BD", 886: "TW",
  960: "MV", 961: "LB", 962: "JO", 963: "SY", 964: "IQ", 965: "KW", 966: "SA",
  967: "YE", 968: "OM", 970: "PS", 971: "AE", 972: "IL", 973: "BH", 974: "QA",
  975: "BT", 976: "MN", 977: "NP", 992: "TJ", 993: "TM", 994: "AZ", 995: "GE",
  996: "KG", 998: "UZ",
};
const TIBET_AREA = new Set([
  "891", "892", "893", "894", "895", "896", "897",                   // Ü-Tsang
  "970", "971", "972", "973", "974", "975", "977", "941", "837",    // Amdo
  "976", "836", "887",                                              // Kham
]);

/* Expects E.164 ("+919876543210"), which is what RingCentral's call log
   carries; a bare 10-digit number is read as North American. */
function countryOf(phone) {
  const s = String(phone || "").trim();
  let d = s.replace(/\D/g, "");
  if (!s.startsWith("+") && d.length === 10) d = "1" + d;
  if (d.startsWith("1") && d.length === 11) {
    const npa = d.slice(1, 4);
    if (NANP_OTHER[npa]) return NANP_OTHER[npa];
    return AREA_REGION[npa] && CA[AREA_REGION[npa]] ? "CA" : "US";
  }
  if (d.startsWith("86") && TIBET_AREA.has(d.slice(2, 5))) return "TIB";
  for (const len of [3, 2, 1]) {
    const hit = CALLING[d.slice(0, len)];
    if (hit) return hit;
  }
  return null;
}

module.exports = { regionOf, countryOf, AREA_REGION };
