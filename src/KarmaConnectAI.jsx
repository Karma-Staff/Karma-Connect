import { useState, useEffect } from "react";

const CSS = `
html,body,#root{margin:0;padding:0;background:#040a24;min-height:100%}
.kc *{box-sizing:border-box;margin:0;padding:0}
.kc{
  --bg:#040a24; --bg2:#071855; --bg3:#0c2150;
  --panel:rgba(255,255,255,.04); --panel2:rgba(255,255,255,.07);
  --border:rgba(74,134,200,.14); --border2:rgba(74,134,200,.26);
  --text:#eef2fb; --muted:#9aa7c4; --faint:#65769e;
  --navy:#071855; --blue:#16385A; --yellow:#FFCF00;
  --steel:#4a86c8; --ice:#cfe0f6;
  --grad:linear-gradient(135deg,#16385A 0%,#2f5e96 55%,#4a86c8 100%);
  font-family:'Manrope',ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
  color:var(--text); background:var(--bg); min-height:100vh;
  position:relative; overflow-x:hidden; letter-spacing:-.01em; line-height:1.5;
}
.kc:before{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
  background:
    radial-gradient(900px 600px at 10% -8%, rgba(22,56,90,.55), transparent 60%),
    radial-gradient(700px 560px at 100% 0%, rgba(74,134,200,.18), transparent 55%),
    radial-gradient(700px 700px at 82% 112%, rgba(7,24,85,.6), transparent 60%);
}
.kc .app{position:relative; z-index:1; display:flex; min-height:100vh}

.kc .side{width:266px; flex:0 0 266px; border-right:1px solid var(--border);
  background:linear-gradient(180deg,rgba(7,24,85,.55),rgba(4,10,36,.6));
  backdrop-filter:blur(14px); padding:22px 16px; display:flex; flex-direction:column; gap:5px;
  position:sticky; top:0; height:100vh; overflow-y:auto;}
.kc .brand{display:flex; align-items:center; gap:12px; padding:6px 8px 20px}
.kc .mark{width:44px; height:44px; border-radius:12px; background:linear-gradient(150deg,#071855,#16385A);
  display:flex; align-items:center; justify-content:center; flex:0 0 44px;
  box-shadow:0 8px 22px -8px rgba(7,24,85,.9), inset 0 0 0 1px rgba(255,207,0,.25)}
.kc .brand h1{font-family:'Lora',serif; font-size:17px; font-weight:700; letter-spacing:-.01em; line-height:1.1}
.kc .brand h1 b{color:var(--yellow); font-weight:700}
.kc .brand span{font-size:10px; color:var(--faint); letter-spacing:.16em; text-transform:uppercase; font-weight:700}
.kc .navlbl{font-size:10px; letter-spacing:.18em; text-transform:uppercase; color:var(--faint); padding:14px 10px 6px; font-weight:700}
.kc .nav{display:flex; align-items:center; gap:11px; padding:10px 11px; border-radius:11px;
  color:var(--muted); font-size:13.5px; font-weight:600; cursor:pointer; border:1px solid transparent;
  transition:all .18s ease; position:relative; width:100%; text-align:left; background:none}
.kc .nav:hover{background:var(--panel); color:var(--text)}
.kc .nav.on{background:var(--panel2); color:var(--text); border-color:var(--border2)}
.kc .nav.on:before{content:""; position:absolute; left:-16px; top:50%; transform:translateY(-50%);
  width:3px; height:20px; border-radius:3px; background:var(--yellow)}
.kc .nav.lock{opacity:.42; cursor:not-allowed}
.kc .nav .ic{width:17px; height:17px; flex:0 0 17px}
.kc .nav .ct{margin-left:auto; font-size:11px; background:var(--panel2); color:var(--ice);
  padding:1px 7px; border-radius:20px; font-weight:700; border:1px solid var(--border)}
.kc .sidefoot{margin-top:auto; padding:12px 10px 2px; font-size:11px; color:var(--faint); line-height:1.6}
.kc .dot{display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--yellow);
  box-shadow:0 0 8px var(--yellow); margin-right:7px; vertical-align:middle}

.kc .main{flex:1; min-width:0; padding:30px 38px 80px; max-width:1180px}
.kc .head{margin-bottom:24px}
.kc .eyebrow{font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--yellow); font-weight:700; margin-bottom:9px}
.kc .head h2{font-family:'Lora',serif; font-size:28px; font-weight:700; letter-spacing:-.01em}
.kc .head p{color:var(--muted); font-size:14px; margin-top:7px; max-width:700px}

.kc .panel{background:var(--panel); border:1px solid var(--border); border-radius:18px; padding:22px;
  backdrop-filter:blur(10px); box-shadow:0 24px 60px -34px rgba(0,0,0,.85)}
.kc .grid2{display:grid; grid-template-columns:1fr 1fr; gap:16px}
.kc .sect-title{font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint);
  font-weight:700; margin:2px 2px 14px; display:flex; align-items:center; gap:9px}
.kc .sect-title:before{content:""; height:1px; width:18px; background:var(--border2)}

.kc .fgrid{display:grid; grid-template-columns:1fr 1fr; gap:14px 16px}
.kc .f{display:flex; flex-direction:column; gap:6px}
.kc .f.full{grid-column:1/-1}
.kc label{font-size:12px; color:var(--muted); font-weight:600}
.kc input,.kc textarea{background:rgba(0,0,0,.3); border:1px solid var(--border); border-radius:11px;
  padding:11px 13px; color:var(--text); font-size:13.5px; font-family:inherit; outline:none; width:100%; resize:vertical;
  transition:border .16s, box-shadow .16s, background .16s}
.kc input::placeholder,.kc textarea::placeholder{color:#41527a}
.kc input:focus,.kc textarea:focus{border-color:var(--steel); background:rgba(0,0,0,.42); box-shadow:0 0 0 3px rgba(74,134,200,.18)}
.kc textarea{min-height:74px; line-height:1.55}

.kc .btn{display:inline-flex; align-items:center; justify-content:center; gap:9px; cursor:pointer;
  font-family:inherit; font-weight:700; font-size:14px; border-radius:12px; padding:13px 22px;
  border:1px solid transparent; transition:transform .12s, box-shadow .18s, background .18s; letter-spacing:-.01em}
.kc .btn:active{transform:translateY(1px)}
.kc .btn.primary{background:var(--yellow); color:#071855; box-shadow:0 14px 32px -14px rgba(255,207,0,.6)}
.kc .btn.primary:hover{box-shadow:0 18px 40px -12px rgba(255,207,0,.78)}
.kc .btn.ghost{background:var(--panel2); color:var(--text); border-color:var(--border2)}
.kc .btn.ghost:hover{background:rgba(255,255,255,.1)}
.kc .btn:disabled{opacity:.5; cursor:not-allowed; transform:none}
.kc .btn.sm{padding:8px 14px; font-size:12.5px; border-radius:10px}

.kc .seg{display:inline-flex; background:rgba(0,0,0,.32); border:1px solid var(--border); border-radius:12px; padding:4px; gap:3px}
.kc .seg button{background:none; border:none; color:var(--muted); font-family:inherit; font-weight:700;
  font-size:13px; padding:8px 16px; border-radius:9px; cursor:pointer; transition:all .16s}
.kc .seg button.on{background:var(--panel2); color:var(--text)}
.kc .senders{display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:16px}
.kc .sbtn{text-align:left; background:rgba(0,0,0,.3); border:1px solid var(--border); border-radius:13px;
  padding:12px 13px; cursor:pointer; font-family:inherit; transition:all .16s; display:flex; flex-direction:column; gap:3px}
.kc .sbtn:hover{border-color:var(--border2); background:rgba(255,255,255,.04)}
.kc .sbtn.on{border-color:var(--yellow); background:rgba(255,207,0,.07); box-shadow:0 0 0 3px rgba(255,207,0,.1)}
.kc .sbtn .sn{font-size:13.5px; font-weight:700; color:var(--text)}
.kc .sbtn .sr{font-size:11.5px; font-weight:600; color:var(--ice)}
.kc .sbtn .st{font-size:10.5px; color:var(--faint)}

.kc .mcard{background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:18px;
  display:flex; flex-direction:column; gap:13px; transition:border .18s, transform .18s, box-shadow .18s; animation:fade .5s ease both}
.kc .mcard:hover{border-color:var(--border2); transform:translateY(-2px); box-shadow:0 22px 46px -26px rgba(0,0,0,.9)}
.kc .mctop{display:flex; align-items:center; gap:9px; flex-wrap:wrap}
.kc .chip{font-size:11px; font-weight:700; padding:4px 11px; border-radius:20px;
  background:rgba(74,134,200,.16); border:1px solid rgba(74,134,200,.34); color:var(--ice)}
.kc .chip.idx{background:rgba(255,255,255,.05); border-color:var(--border); color:var(--faint); min-width:30px; text-align:center}
.kc .mbody{font-size:14px; line-height:1.62; color:#e0e8f5; white-space:pre-wrap}
.kc .charc{font-size:11px; color:var(--faint); font-weight:600; margin-left:auto}
.kc .charc.over{color:#ff8a8a}
.kc .scores{display:flex; gap:18px}
.kc .score{flex:1}
.kc .score .sl{display:flex; justify-content:space-between; font-size:11px; color:var(--muted); font-weight:600; margin-bottom:5px}
.kc .score .sl b{color:var(--text)}
.kc .bar{height:6px; border-radius:6px; background:rgba(255,255,255,.08); overflow:hidden}
.kc .bar i{display:block; height:100%; border-radius:6px; background:var(--grad); transition:width .9s cubic-bezier(.22,1,.36,1)}
.kc .bar.alt i{background:linear-gradient(135deg,#2faf7a,#52d39e)}
.kc .bar.gold i{background:linear-gradient(135deg,#d9a400,#FFCF00)}
.kc .reason{font-size:12.5px; color:var(--muted); line-height:1.55; border-left:2px solid var(--border2); padding-left:11px}
.kc .reason b{color:var(--yellow); font-weight:700}
.kc .mact{display:flex; gap:8px; align-items:center; border-top:1px solid var(--border); padding-top:12px}
.kc .iconbtn{background:var(--panel2); border:1px solid var(--border); color:var(--muted); cursor:pointer;
  border-radius:9px; padding:7px 11px; font-size:12px; font-weight:600; font-family:inherit;
  display:inline-flex; align-items:center; gap:6px; transition:all .15s}
.kc .iconbtn:hover{color:var(--text); border-color:var(--border2); background:rgba(255,255,255,.08)}
.kc .iconbtn.fav.on{color:var(--yellow); border-color:rgba(255,207,0,.45); background:rgba(255,207,0,.12)}
.kc .iconbtn svg{width:14px; height:14px}

.kc .iprofile{display:grid; grid-template-columns:1fr 1fr; gap:16px}
.kc .iblock{background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:18px; animation:fade .5s ease both}
.kc .iblock.full{grid-column:1/-1}
.kc .iblock h4{font-size:12px; letter-spacing:.1em; text-transform:uppercase; color:var(--ice); font-weight:700; margin-bottom:12px}
.kc .iblock p{font-size:14px; color:#e0e8f5; line-height:1.65}
.kc .iblock ul{list-style:none; display:flex; flex-direction:column; gap:9px}
.kc .iblock li{font-size:13.5px; color:#d3ddee; line-height:1.5; padding-left:20px; position:relative}
.kc .iblock li:before{content:""; position:absolute; left:2px; top:8px; width:6px; height:6px; border-radius:2px; background:var(--yellow)}
.kc .fitgrid{display:grid; grid-template-columns:repeat(3,1fr); gap:14px}
.kc .fitcard{background:rgba(0,0,0,.22); border:1px solid var(--border); border-radius:13px; padding:14px}
.kc .fitcard .fh{display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px}
.kc .fitcard .fn{font-size:12px; font-weight:700; color:var(--muted)}
.kc .fitcard .fv{font-family:'Lora',serif; font-size:22px; font-weight:700; color:var(--text)}
.kc .fitcard .fc{font-size:10.5px; color:var(--faint); margin-top:8px; text-transform:uppercase; letter-spacing:.06em}
.kc .fitcard .fw{font-size:12px; color:var(--muted); line-height:1.5; margin-top:8px}

.kc .empty{text-align:center; padding:58px 20px; border:1px dashed var(--border2); border-radius:18px; background:rgba(255,255,255,.015)}
.kc .empty .eic{width:54px; height:54px; border-radius:15px; background:var(--panel2); border:1px solid var(--border2);
  display:flex; align-items:center; justify-content:center; margin:0 auto 16px; color:var(--ice)}
.kc .empty h3{font-family:'Lora',serif; font-size:19px; font-weight:700; margin-bottom:8px}
.kc .empty p{color:var(--muted); font-size:13.5px; max-width:460px; margin:0 auto 20px}
.kc .loader{padding:32px; display:flex; flex-direction:column; gap:13px; max-width:400px; margin:6px auto}
.kc .lstage{display:flex; align-items:center; gap:12px; font-size:13.5px; color:var(--faint); font-weight:600; opacity:.4; transition:opacity .3s, color .3s}
.kc .lstage.act{opacity:1; color:var(--text)}
.kc .lstage.done{opacity:.85; color:var(--muted)}
.kc .lstage .ld{width:18px; height:18px; flex:0 0 18px; border-radius:50%; border:2px solid var(--border2); display:flex; align-items:center; justify-content:center}
.kc .lstage.act .ld{border-color:var(--steel); border-top-color:transparent; animation:spin .7s linear infinite}
.kc .lstage.done .ld{border-color:#52d39e; background:#52d39e}
.kc .lstage.done .ld svg{width:11px; height:11px; color:#06251a}

.kc .toprow{display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:20px}
.kc .pchip{display:inline-flex; align-items:center; gap:10px; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:9px 14px; margin-bottom:20px}
.kc .pchip .av{width:32px; height:32px; border-radius:9px; background:var(--grad); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:13px; color:#fff; font-family:'Lora',serif}
.kc .pchip .pn{font-size:13.5px; font-weight:700}
.kc .pchip .pr{font-size:11.5px; color:var(--muted)}
.kc .err{background:rgba(255,90,90,.08); border:1px solid rgba(255,90,90,.3); color:#ffb3b3; border-radius:12px; padding:13px 16px; font-size:13px}
.kc .fa{display:flex; flex-direction:column; gap:16px}
.kc .hint{font-size:12px; color:var(--yellow); display:flex; gap:7px; align-items:flex-start; margin-top:4px; line-height:1.5}
.kc .tline{position:relative; padding-left:30px}
.kc .tline:before{content:""; position:absolute; left:9px; top:6px; bottom:6px; width:2px; background:var(--border2)}
.kc .titem{position:relative; margin-bottom:16px}
.kc .titem:before{content:""; position:absolute; left:-26px; top:20px; width:13px; height:13px; border-radius:50%; background:var(--bg3); border:2px solid var(--steel); box-shadow:0 0 0 4px rgba(74,134,200,.14)}
.kc .stagehd{font-family:'Lora',serif; font-size:14px; font-weight:700; margin-bottom:3px}

@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fade{from{opacity:0; transform:translateY(10px)}to{opacity:1; transform:none}}
@media(max-width:920px){
  .kc .side{display:none}
  .kc .main{padding:22px 18px 60px}
  .kc .fgrid,.kc .grid2,.kc .iprofile,.kc .senders,.kc .fitgrid,.kc .rpa-grid{grid-template-columns:1fr}
}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
.kc .rpa-grid{display:grid; grid-template-columns:1fr 1fr; gap:16px}
.kc .rpa-block{background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:18px; animation:fade .5s ease both}
.kc .rpa-block.full{grid-column:1/-1}
.kc .rpa-block.green{border-color:rgba(82,211,158,.25); background:rgba(82,211,158,.04)}
.kc .rpa-block.yellow{border-color:rgba(255,207,0,.25); background:rgba(255,207,0,.03)}
.kc .rpa-block.red{border-color:rgba(255,90,90,.22); background:rgba(255,90,90,.04)}
.kc .rpa-block h4{font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--ice); font-weight:700; margin-bottom:12px; display:flex; align-items:center; gap:8px}
.kc .rpa-block h4 span{font-size:10px; background:rgba(255,255,255,.07); border:1px solid var(--border); color:var(--faint); padding:2px 8px; border-radius:20px; letter-spacing:.1em}
.kc .rpa-val{font-size:14px; color:#e0e8f5; line-height:1.65}
.kc .rpa-list{list-style:none; display:flex; flex-direction:column; gap:8px}
.kc .rpa-list li{font-size:13px; color:#d3ddee; line-height:1.5; padding-left:18px; position:relative}
.kc .rpa-list li:before{content:""; position:absolute; left:2px; top:8px; width:5px; height:5px; border-radius:2px; background:var(--yellow)}
.kc .rpa-list li.green:before{background:#52d39e}
.kc .rpa-list li.red:before{background:#ff8a8a}
.kc .rpa-kv{display:flex; flex-direction:column; gap:7px}
.kc .rpa-row{display:flex; gap:10px; font-size:13px; line-height:1.5; align-items:baseline}
.kc .rpa-row .rk{color:var(--faint); font-weight:600; min-width:130px; flex:0 0 130px; font-size:11.5px; letter-spacing:.03em}
.kc .rpa-row .rv{color:#e0e8f5}
.kc .rpa-row .rv.unverified{color:var(--faint); font-style:italic}
.kc .score-ring-wrap{display:flex; gap:18px; flex-wrap:wrap; margin-bottom:4px}
.kc .score-ring{display:flex; flex-direction:column; align-items:center; gap:6px}
.kc .score-ring .sr-val{font-family:'Lora',serif; font-size:26px; font-weight:700; color:var(--text); line-height:1}
.kc .score-ring .sr-lbl{font-size:10px; color:var(--faint); text-transform:uppercase; letter-spacing:.1em; font-weight:700; text-align:center}
.kc .score-ring .sr-bar{width:64px; height:5px; border-radius:5px; background:rgba(255,255,255,.08); overflow:hidden}
.kc .score-ring .sr-bar i{display:block; height:100%; border-radius:5px; transition:width 1s cubic-bezier(.22,1,.36,1)}
.kc .signal-badge{display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700; padding:4px 11px; border-radius:20px; border:1px solid}
.kc .signal-badge.high{color:#52d39e; border-color:rgba(82,211,158,.35); background:rgba(82,211,158,.08)}
.kc .signal-badge.medium{color:var(--yellow); border-color:rgba(255,207,0,.35); background:rgba(255,207,0,.08)}
.kc .signal-badge.low{color:var(--faint); border-color:var(--border); background:var(--panel)}
.kc .rpa-phase{display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--border); font-size:13px}
.kc .rpa-phase:last-child{border-bottom:none}
.kc .rpa-phase .ph-num{width:26px; height:26px; border-radius:8px; background:var(--panel2); border:1px solid var(--border2); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; color:var(--ice); flex:0 0 26px}
.kc .rpa-phase .ph-num.act{background:rgba(74,134,200,.25); border-color:var(--steel); color:var(--text); animation:pulse 1.2s ease infinite}
.kc .rpa-phase .ph-num.done{background:rgba(82,211,158,.18); border-color:rgba(82,211,158,.4); color:#52d39e}
.kc .rpa-phase .ph-lbl{font-weight:600; color:var(--muted)}
.kc .rpa-phase .ph-lbl.act{color:var(--text)}
.kc .rpa-phase .ph-lbl.done{color:var(--muted)}
.kc .rpa-phase .ph-status{margin-left:auto; font-size:11px; color:var(--faint); font-weight:600}
.kc .rpa-phase .ph-status.act{color:var(--steel)}
.kc .rpa-phase .ph-status.done{color:#52d39e}
.kc .conf-badge{font-size:11px; font-weight:700; padding:2px 9px; border-radius:20px; border:1px solid}
.kc .conf-badge.high{color:#52d39e; border-color:rgba(82,211,158,.35); background:rgba(82,211,158,.08)}
.kc .conf-badge.medium{color:var(--yellow); border-color:rgba(255,207,0,.35); background:rgba(255,207,0,.08)}
.kc .conf-badge.low{color:#ff8a8a; border-color:rgba(255,90,90,.3); background:rgba(255,90,90,.06)}
.kc .push-banner{background:rgba(82,211,158,.07); border:1px solid rgba(82,211,158,.25); border-radius:14px; padding:14px 18px; display:flex; align-items:center; gap:14px; margin-bottom:20px}
.kc .push-banner svg{color:#52d39e; flex:0 0 20px}
.kc .push-banner p{font-size:13px; color:#e0e8f5; line-height:1.55}
`;

function KarmaMark({ color = "#fff", w = 24 }) {
  return (
    <svg width={w} height={w * (74 / 126)} viewBox="0 0 126 74" fill="none">
      <rect x="2" y="56" width="12" height="12" rx="1.5" fill={color} />
      <rect x="20" y="44" width="12" height="24" rx="1.5" fill={color} />
      <rect x="38" y="32" width="12" height="36" rx="1.5" fill={color} />
      <rect x="56" y="18" width="12" height="50" rx="1.5" fill={color} />
      <rect x="74" y="2" width="13" height="66" rx="1.5" fill={color} />
      <path d="M112 6 L88 36 L112 66" fill="none" stroke={color} strokeWidth="13" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const BRAND_DNA = `
KARMA STAFF BRAND DNA — this governs every word you produce:
COMPANY NAME: always "Karma Staff" (two words, capital K, capital S). Never "KarmaStaff", "karma staff", or "KS".
WHO WE ARE: Karma Staff provides full-time remote professionals from India who integrate directly into the daily workflows of restoration businesses. Not a generic staffing agency — an expert operational partner with real knowledge of Xactimate, Symbility, insurance documentation, estimating workflows, and the administrative reality behind every restoration job. Founded 2023. Trusted by restoration companies including PuroClean, Rainbow Restoration, 1-800 Water Damage, Paul Davis, Steamatic, and Service Squad (TX).
ARCHETYPE — THE EXPERT PARTNER: don't just answer the question asked; understand the business well enough to see what the owner actually needs. Proactive, not reactive. Earns its place through performance, not promises.
PERSONALITY: professional (high standards without coldness), confident (speaks from experience, never over-sells), human (real person to real person), dependable, calm under pressure (never adds to the noise), grounded (acknowledges real challenges, never overpromises).
VOICE: write like an experienced operational partner. Clear, practical, honest. Write to be understood and trusted, not to sound impressive. Test: would a busy, skeptical restoration owner find this useful, or roll their eyes? If the latter, rewrite it.
APPROVED SERVICE LANGUAGE: Office Administration (scheduling, coordination, documentation, CRM updates, workflow support); Estimating Support (Xactimate, Symbility, restoration documentation); Bookkeeping (AR/AP, reconciliations, invoicing, payroll support, financial reporting); Customer Success Support (communication, scheduling, follow-ups, client coordination); Sales Support (lead management, outreach, follow-ups, pipeline); Digital Marketing Support (social, SEO, content, email, online visibility); Medical Biller Admin (claims, compliance, billing).
NEVER (reads as machine-made or untrustworthy): em dashes used for dramatic effect; contrast-for-drama ("we don't just do X, we do Y"); motivational filler ("success starts with a single decision"); buzzwords (industry-leading, game-changing, unlock your potential, transformative); stacked bullet fragments or AI-pattern hooks; repetitive sentence structures; exaggerated or unverifiable claims.
PHILOSOPHY: "What comes around, goes around." Use only when it genuinely fits, never as filler.`;

const SYSTEM = `You are KARMA CONNECT — an elite outbound strategist who combines a top 1% LinkedIn SDR, a meticulous prospect researcher, a sales psychologist, and a sharp copywriter into one mind. You write outreach that reads as if it were personally handwritten after genuinely researching the individual. You know property restoration, construction, roofing, HVAC, plumbing, and property management intimately. You ALWAYS return output in the EXACT format requested with NO preamble.\n\n` + BRAND_DNA;

const STYLE_REF = `
KARMA STAFF TEAM VOICE (how our real lead-gen team writes — match the feel, never copy verbatim):
- Warm, human, peer-to-peer, humble, low-pressure. Reads like a real operator who lives the day-to-day — never pushy, never hypey.
- Speak the prospect's world in their own words: juggling crews, estimates, scheduling, follow-ups, admin, billing, cash flow, job costing, backend chaos.
- Keep it simple and human, like a real owner texting. Brief, clear, no jargon, no overpromotion.
- When it fits (relationship / meeting / follow-up), introduce the sender briefly in first person: name + role + ONE real credibility detail from the sender section.
- Connect-framing we lean on: "exchange perspectives / insights", "see if there's any overlap", "be a helpful resource or partner for your team". Owner-to-owner warmth when the sender is an owner.
- Social proof only when natural, and only from the sender's listed proof points.
- CTA (MEETING + FOLLOW-UP only): soft and optional, often with reassurance ("no worries if now isn't the right time"; "even if we don't end up working together, a 10–15 min chat is worth it"). End with the sender's CALENDAR LINK on its own final line — use the exact link from the sender section; if none, use {{calendar link}}. Connection notes and relationship openers carry NO link and NO pitch.
- You may close longer messages with a light sign-off using the sender's FIRST name only. Never add full signatures, repeated titles, emails, phone numbers, URLs, or contact blocks.`;

const HUMANIZE = `WRITING STANDARDS (critical):
- Sound like a sharp human wrote it in 30 focused seconds, not like AI or a template.
- Vary sentence length and rhythm. Plain, confident, specific language.
- BANNED phrases and patterns: "I hope this message finds you well", "just checking in", "following up", "circling back", "reaching out", "touch base", "pick your brain", "as a fellow", "I came across your profile"; contrast-for-drama ("we don't just X, we Y"); motivational filler; buzzwords (industry-leading, game-changing, unlock your potential, transformative); stacked bullet fragments; repetitive sentence structures. No corporate buzzwords, no emoji unless truly natural, no exclamation spam.
- ABSOLUTE HYPHEN BAN — this is the single most important formatting rule: NEVER use an em dash (—), en dash (–), or a hyphen used as a separator or pause (word - word or word-word mid-sentence). These are the #1 AI-writing fingerprint and will get the message flagged immediately. Instead: split into two sentences, use a comma, use "and", use "so", use "because", or rewrite the clause entirely. Example: WRONG: "I work with restoration owners — people juggling crews and estimates." RIGHT: "I work with restoration owners who are juggling crews and estimates." Another: WRONG: "Clean books mean faster billing — and better cash flow." RIGHT: "Clean books mean faster billing and better cash flow." The only acceptable hyphen is in a compound adjective that is standard English (e.g. "full-time", "well-known") and only when no natural alternative exists.
- About the PROSPECT: never invent facts (awards, news, metrics, projects) not provided — infer at role/industry level instead. About the SENDER (Karma Staff): use ONLY the proof points in the sender section; never invent new clients, numbers, or credentials.` + STYLE_REF;

const KS_COMPANY = `COMPANY: Karma Staff provides full-time remote professionals from India who integrate directly into restoration business workflows. Approved services and language: Office Administration (scheduling, coordination, documentation, CRM updates, workflow support); Estimating Support (Xactimate, Symbility, restoration documentation); Bookkeeping (AR/AP, reconciliations, invoicing, payroll support, financial reporting); Customer Success Support (communication, scheduling, follow-ups, client coordination); Sales Support (lead management, outreach, follow-ups, pipeline); Digital Marketing Support (social, SEO, content, email, online visibility); Medical Biller Admin (claims, compliance, billing).

PROOF POINTS (real — use ONLY these, never invent more): IICRC certified; a vendor member of the Restoration Industry Association (RIA); an operational partner trusted by restoration companies including PuroClean, Rainbow Restoration, 1-800 Water Damage, Paul Davis, Steamatic, and Service Squad (TX); estimators trained on Xactimate and Symbility; support that is dependable and aligned to the pace of the business.

CREDIBILITY MARKERS (industry trust signals — use when they fit naturally, never stack them): "IICRC certified" and "vendor member of RIA" show we know the restoration trade and hold ourselves to its standards. They land best in meeting requests and follow-ups as a brief, plain aside (e.g. "we're IICRC certified and an RIA vendor member, so we already speak Xactimate and the insurance side"). Mention at most one or two, woven into a sentence, never as a badge list or a boast.

VALUE: reduce administrative pressure and backend load, cleaner books and faster billing, better job costing and cash flow, estimates that go out on time, and freeing owners from juggling crews + estimates + admin — without local hiring overhead.`;

const SENDERS = [
  { id: "nordon", name: "Nordon Chophel", role: "Co-founder", tag: "Operations · Restoration", calendar: "https://ln.run/XznAZ", email: "tnordon@karmastaff.com",
    head: `SENDER IDENTITY (write in this person's first-person voice):\nNordon Chophel — Co-founder, Karma Staff. Background: MBA, IICRC certified, hands-on experience at a PuroClean franchise; stays close to the day-to-day with the crews.\nANGLE THIS SENDER LEANS INTO: operational pressure — juggling crews, estimates, scheduling, follow-ups and admin; keeping operations running smoothly without added overhead.\nCALENDAR LINK: https://ln.run/XznAZ\nEMAIL: tnordon@karmastaff.com\nSIGN-OFF NAME: Nordon` },
  { id: "ogyen", name: "Ogyen", role: "CFO", tag: "Finance · Bookkeeping", calendar: "https://ziply.pk/Karmastaff", email: "ogyen@karmastaff.com",
    head: `SENDER IDENTITY (write in this person's first-person voice):\nOgyen — CFO, Karma Staff. 15+ years in finance leadership, including time as a Senior Manager at Deloitte.\nANGLE THIS SENDER LEANS INTO: financial clarity — clean books, accurate job costing, faster billing, healthier cash flow. Core services to name: estimating support, bookkeeping, customer success support.\nCALENDAR LINK: https://ziply.pk/Karmastaff\nEMAIL: ogyen@karmastaff.com\nSIGN-OFF NAME: Ogyen` },
  { id: "jigme", name: "Tenzin Jigme", role: "Owner", tag: "Owner-to-owner", calendar: "https://calendly.com/tjigme-karmastaff/30min", email: "tjigme@karmastaff.com",
    head: `SENDER IDENTITY (write in this person's first-person voice):\nTenzin Jigme — small business owner running a few ventures, including Karma Staff. Speaks owner-to-owner, peer-to-peer.\nANGLE THIS SENDER LEANS INTO: genuine peer connection — "see if there's any overlap or ways we might support each other over time." The gap between finishing a job and getting paid is usually just a mountain of admin; bridge it via estimating + bookkeeping so owners stay in the field. Warmest, simplest, most human tone.\nCALENDAR LINK: https://calendly.com/tjigme-karmastaff/30min\nEMAIL: tjigme@karmastaff.com\nSIGN-OFF NAME: Tenzin` },
  { id: "wangjor", name: "Tenzin Wangjor", role: "Marketing Director", tag: "Estimating · Backend ops", calendar: "https://calendly.com/twangjor-karmastaff/meeting-with-karma-staff", email: "twangjor@karmastaff.com",
    head: `SENDER IDENTITY (write in this person's first-person voice):\nTenzin Wangjor — with Karma Staff; works with restoration and construction companies.\nANGLE THIS SENDER LEANS INTO: estimating workflow bottlenecks — estimates backing up when the field gets busy; keeping estimating workflows consistent so nothing falls behind and estimates go out on time. Likes to "exchange insights" and be "a helpful resource for your team."\nCALENDAR LINK: https://calendly.com/twangjor-karmastaff/meeting-with-karma-staff\nEMAIL: twangjor@karmastaff.com\nSIGN-OFF NAME: Tenzin` },
];
const senderOffer = (s) => s.head + "\n\n" + KS_COMPANY;

// Claude model. claude-sonnet-4-6 is the speed/intelligence sweet spot (fast + cheaper).
// For maximum depth on hard prospects, change to claude-opus-4-8 — same API, just the string.
const CLAUDE_MODEL = "claude-sonnet-4-6";

// Core Anthropic Messages API call (raw HTTP, direct from the browser). Returns joined text.
async function anthropicMsg(system, user, { maxTokens = 1000, useSearch = false } = {}) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing API key. Add VITE_ANTHROPIC_API_KEY to your .env file.");
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    // Cache the (large, identical-every-call) system prompt. Cached input tokens cost
    // ~10% of fresh ones, so repeated calls in a prospect run get much cheaper.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  };
  // Anthropic server-side web search tool. max_uses caps searches (the main token cost).
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: useSearch === "deep" ? 5 : 3 }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let errMsg = "AI request failed (" + res.status + ").";
    try { const errData = await res.json(); errMsg += " " + (errData?.error?.message || ""); } catch (e) {}
    throw new Error(errMsg + " Please try again.");
  }
  const data = await res.json();
  // Join all text blocks (search runs add non-text blocks we ignore).
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Back-compat wrapper so existing call sites keep their (system, prompt, useSearch, maxTokens) shape.
async function callClaude(system, prompt, useSearch = false, maxTokens = 1000) {
  return anthropicMsg(system, prompt, { maxTokens, useSearch });
}

function extractObjects(text) {
  const objs = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start !== -1) { try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch (e) {} start = -1; } }
  }
  return objs;
}

// Attempt to fix common JSON issues: unescaped newlines/tabs inside strings, trailing commas
function repairJSON(t) {
  // Remove trailing commas before } or ]
  t = t.replace(/,\s*([\]}])/g, "$1");
  // Replace literal newlines inside strings with \n
  let inStr = false, esc = false, out = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === "\\") { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function safeJSON(text) {
  if (!text) throw new Error("Empty response from AI. Please try again.");
  let t = text.trim();
  // Strip markdown code fences
  t = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  // Try direct parse
  try { return JSON.parse(t); } catch (e) {}
  // Try repairing then parsing
  try { return JSON.parse(repairJSON(t)); } catch (e) {}
  // Try extracting JSON array
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a !== -1 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {}
    try { return JSON.parse(repairJSON(t.slice(a, b + 1))); } catch (e) {}
  }
  // Try extracting JSON object
  const c = t.indexOf("{"), d = t.lastIndexOf("}");
  if (c !== -1 && d > c) {
    try { return JSON.parse(t.slice(c, d + 1)); } catch (e) {}
    try { return JSON.parse(repairJSON(t.slice(c, d + 1))); } catch (e) {}
  }
  // Last resort: extract all objects via brace matching
  const salv = extractObjects(t);
  if (salv.length) return salv.length === 1 ? salv[0] : salv;
  throw new Error("Could not read the AI response — the output was malformed. Try again.");
}

// Post-processor: remove all em/en dashes and mid-sentence separator hyphens from generated messages.
// Prompt instruction is the first line of defense; this is the safety net.
function stripHyphens(text) {
  if (!text) return text;
  return text
    // em dash with optional spaces -> replace with comma+space or just space depending on context
    .replace(/\s*\u2014\s*/g, (_, offset, str) => {
      // if preceded by a word char and followed by a word char, use comma
      const before = str[offset - 1];
      return (before && /\w/.test(before)) ? ", " : " ";
    })
    // en dash with spaces (used as separator) -> comma or space
    .replace(/\s*\u2013\s*/g, ", ")
    // hyphen used as mid-sentence pause: " - " -> ", "
    .replace(/ - /g, ", ")
    // double hyphen -- used as dash -> comma
    .replace(/\s*--\s*/g, ", ")
    // clean up any double commas or comma+space artifacts
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Apply stripHyphens to every message field in a parsed array or object
function cleanMessages(parsed) {
  if (!parsed) return parsed;
  const cleanItem = (item) => {
    if (!item || typeof item !== "object") return item;
    const out = { ...item };
    if (typeof out.message === "string") out.message = stripHyphens(out.message);
    if (typeof out.reasoning === "string") out.reasoning = stripHyphens(out.reasoning);
    if (typeof out.fresh === "string") out.fresh = stripHyphens(out.fresh);
    if (typeof out.persona === "string") out.persona = stripHyphens(out.persona);
    return out;
  };
  if (Array.isArray(parsed)) return parsed.map(cleanItem);
  return cleanItem(parsed);
}

// Pre-trim a raw LinkedIn page paste: drop obvious UI/nav chrome and collapse blank runs
// so we ship fewer junk tokens to the model. Conservative — keeps all real profile text.
function stripLinkedInNoise(raw) {
  if (!raw) return "";
  const noise = /^(Skip to (main|search)|Keyboard shortcuts|Close jump menu|Search\b|Home$|My Network|Jobs$|Messaging|Notifications$|Try Premium|Try for free|Promoted|Ad$|People also viewed|People you may know|Others named|Show (all|more)|See (all|more|profile)|Follow$|Following$|\+ Follow|Connect$|Message$|More$|Pending$|Status is (online|offline|reachable)|new feed update|Activate to view larger image|Loading|Report this|Save$|Saved$|Like$|Comment$|Repost$|Send$|·|•|\d+(st|nd|rd|th)\s*degree connection)/i;
  const out = [];
  let blanks = 0;
  for (const ln of raw.split(/\r?\n/)) {
    const t = ln.trim();
    if (!t) { if (++blanks > 1) continue; out.push(""); continue; }
    blanks = 0;
    if (noise.test(t)) continue;
    if (t.length <= 2) continue; // stray icons / counters
    out.push(t);
  }
  return out.join("\n");
}

// Lightweight COMPANY-only research (one web-search call). The person comes from the
// Deep LinkedIn paste panel, so we no longer run the heavy multi-pass profile pipeline.
const COMPANY_SYSTEM = `You are a precise B2B company researcher for Karma Staff. State only facts you can verify from web search and the company's own website. Never fabricate names, numbers, or claims. Leave any field you cannot verify as an empty string "". Return ONLY a single valid JSON object, no markdown or code fences, starting with { and ending with }.`;

function companyResearchPrompt(prospect, coUrl) {
  const L = (k, v) => (v && String(v).trim() ? k + ": " + String(v).trim() + "\n" : "");
  let s = "Research THIS COMPANY for B2B sales prep (restoration / construction staffing context).\n";
  s += L("Company website", coUrl);
  s += L("Company name", prospect.company);
  s += L("Industry (if known)", prospect.industry);
  s += L("Location (if known)", prospect.location);
  s += `\nUsing at most 2 targeted web searches (the company site first), extract verifiable COMPANY facts only. Return ONLY this JSON:
{"company":"","website":"","industry":"","location":"","employeeCount":"","companyDesc":"","services":[],"recentNews":[],"summary":""}
- "companyDesc": 1-2 sentences on what they do. "services": up to 5 short items. "recentNews": up to 3 short, dated signals (hiring, expansion, storm season, etc.).
- "summary": one neutral sentence on what you found. Leave anything unverifiable as "". Start with { end with }.`;
  return s;
}

function buildContext(p, offer, analysis, org) {
  const L = (k, v) => (v && String(v).trim() ? k + ": " + String(v).trim() + "\n" : "");
  let s = "PROSPECT\n";
  s += L("Name", [p.firstName, p.lastName].filter(Boolean).join(" "));
  s += L("Job title", p.title); s += L("Company", p.company); s += L("Industry", p.industry); s += L("Location", p.location);
  s += L("LinkedIn headline", p.headline); s += L("LinkedIn about", p.about); s += L("LinkedIn experience", p.experience);
  s += L("Company website", p.website); s += L("Company description", p.companyDesc); s += L("Recent news / signals", p.news);
  s += L("Personal notes", p.notes); s += L("Mutual interests", p.mutual); s += L("Additional research", p.research);
  s += L("Known pain points", p.pain); s += L("Growth objectives", p.growth); s += L("Staffing challenges", p.staffing); s += L("Operational challenges", p.ops);
  s += "\nSENDER (you are reaching out on behalf of):\n" + offer.trim() + "\n";
  if (org && org.trim()) s += "\nORGANIZATIONAL KNOWLEDGE (admin-provided — use when relevant, never contradict it):\n" + org.trim() + "\n";
  if (analysis) s += "\nYOUR INTELLIGENCE PROFILE OF THIS PROSPECT:\n" + JSON.stringify(analysis) + "\n";
  return s;
}
const ARR = `Return ONLY a valid JSON array (no markdown, no commentary).`;

function pAnalysis(base) {
  return base + `\nTASK: Build a concise intelligence profile of this prospect to drive personalized outreach, AND score fit for Karma Staff. Infer from role and industry where data is missing, but never fabricate specific facts.

CRITICAL OUTPUT RULES:
- Return ONLY a single valid JSON object. No markdown. No code fences. No preamble. Start with { and end with }.
- Every string value must be properly JSON-escaped. No unescaped quotes or newlines inside strings.
- Keep every array item under 12 words. Keep "why" fields under 15 words. Keep "persona" under 40 words.
- All arrays must have exactly the count specified — no more, no fewer.

Return this exact structure:
{"persona":"2-3 sentence portrait (under 40 words total)","responsibilities":["item 1","item 2","item 3","item 4"],"painPoints":["item 1","item 2","item 3","item 4"],"goals":["item 1","item 2","item 3"],"hooks":["item 1","item 2","item 3","item 4"],"trends":["item 1","item 2","item 3"],"challenges":["item 1","item 2","item 3"],"fit":{"icp":{"score":75,"confidence":"medium","why":"one short sentence"},"qualification":{"score":70,"confidence":"medium","why":"one short sentence"},"readiness":{"score":60,"confidence":"low","why":"one short sentence"}}}

Score honestly. Not everything is a 90.`;
}
function pConnection(base, n, avoid) {
  return base + `\nTASK: Write ${n} DISTINCT LinkedIn CONNECTION REQUEST notes (the short note on an invite).\nHARD RULES:\n- Each note MUST be 300 characters or fewer (keep a safe margin).\n- NEVER pitch, sell, mention services/staffing, or ask for a meeting or call. The ONLY goal is an accepted, personal-feeling connection.\n- Each note uses a clearly DIFFERENT angle.\n${avoid && avoid.length ? "- Do NOT reuse these angles: " + avoid.join("; ") + "\n" : ""}${HUMANIZE}\n${ARR} ${n} objects:\n[{"message":"the note","angle":"2-4 word label","personalization":<int 58-96>,"acceptance":<int 58-95>,"reasoning":"one sentence on why it lands"}]`;
}
function pRelationship(base, n, avoid) {
  return base + `\nTASK: The prospect just ACCEPTED the connection. Write ${n} DISTINCT first messages that build a relationship.\nHARD RULES:\n- Build rapport, start a real conversation. NO pitching, NO selling, NO meeting ask.\n- Reference role / company / industry / background in a way that invites a reply. 2-4 sentences. Different conversational style each.\n${avoid && avoid.length ? "- Do NOT reuse these styles/angles: " + avoid.join("; ") + "\n" : ""}${HUMANIZE}\n${ARR} ${n} objects:\n[{"message":"the message","angle":"2-4 word style label","personalization":<int 58-96>,"acceptance":<int 55-92>,"reasoning":"one sentence on why it earns a reply"}]`;
}
const MEET_LEN = {
  short: "SHORT body — 1-2 tight sentences. Direct, friendly, one clear value.",
  standard: "STANDARD body — 3-4 sentences. Set context, name a reason it is worth 15 min, easy yes.",
  executive: "EXECUTIVE body — 2-3 sentences. Peer-to-peer, time-respecting, outcome-focused.",
};
function pMeeting(base, n, len, avoid) {
  return base + `\nTASK: Rapport is established. Write ${n} DISTINCT MEETING REQUEST messages. Body length: ${MEET_LEN[len]}

MANDATORY FORMAT — every message MUST follow this exact structure, no exceptions:
Hi [prospect first name],

[body content here — personalized, value-focused, low-pressure, ends with the calendar link on its own line]

[CALENDAR LINK — paste the exact link from the sender section, on its own line, no label before it]

Best,
[SIGN-OFF NAME from sender section]
[EMAIL from sender section]
www.karmastaff.com

HARD RULES:
- The greeting is always "Hi [first name]," on its own line, then a blank line before the body.
- The calendar link goes AFTER the body, on its own line, before the sign-off.
- The sign-off block is always exactly: Best, / [first name only] / [email] / www.karmastaff.com — each on its own line.
- Body is value-focused, personalized, natural. Never salesy or pushy. Make clear why a short conversation is worth their time. Different value angle each variation.
- TRUST: in roughly half of the variations, work in ONE credibility marker from the sender's proof points (most naturally "IICRC certified" or "vendor member of RIA") as a brief, plain aside that signals we know the restoration trade and take accountability seriously. Keep it woven into a sentence, never a badge list, never in every variation, never boastful.
- No extra commentary, no labels, no asterisks around any part.
${avoid && avoid.length ? "- Do NOT reuse these angles: " + avoid.join("; ") + "\n" : ""}${HUMANIZE}
${ARR} ${n} objects:
[{"message":"the full formatted message exactly as it should be sent","angle":"2-4 word value angle","personalization":<int 58-96>,"acceptance":<int 45-88>,"reasoning":"one sentence on why it converts"}]`;
}
function pFollowup(base) {
  return base + `\nTASK: No reply after the meeting request. Write a 5-step FOLLOW-UP SEQUENCE. Each step MUST introduce something genuinely NEW — never repeat earlier messages, never use "just checking in" / "following up" / "circling back".

Steps (in order): 1) Gentle reminder  2) New insight  3) Different angle  4) Industry-specific observation  5) Respectful close-out (graceful, no guilt).

MANDATORY FORMAT for every step — follow this exact structure:
Hi [prospect first name],

[body — 2-3 sentences, something genuinely new each time]

[CALENDAR LINK from sender section on its own line — include on steps 1 through 4 only, omit on step 5 close-out]

Best,
[SIGN-OFF NAME from sender section]
[EMAIL from sender section]
www.karmastaff.com

${HUMANIZE}
${ARR} EXACTLY 5 objects in order:
[{"stage":"Gentle reminder","message":"the full formatted message","fresh":"the new element introduced","reasoning":"why it works"}]`;
}
function pEnrich(linkedinUrl, companyUrl) {
  return `Use web search to research this person and their company for B2B sales prep. Search by name + company + domain, and read the company website for firmographics. LinkedIn profile pages usually can't be opened directly by tools, so rely on what surfaces in search results and on the company site.\n\nINPUTS\nLinkedIn URL: ${linkedinUrl || "(none provided)"}\nCompany website: ${companyUrl || "(none provided)"}\n\nExtract ONLY facts you can actually verify from search results. Leave any field you cannot verify as an empty string "". NEVER guess names, titles, locations, or numbers — a blank field is correct and expected.\n\nReturn ONLY this JSON (no markdown):\n{"firstName":"","lastName":"","title":"","company":"","industry":"","location":"","headline":"","about":"","experience":"","website":"","companyDesc":"","news":"","research":"2-4 sentence neutral synthesis of what you found and where it came from","confidence":"high|medium|low","found":["each concrete fact you verified, short"],"unverified":["fields you could not confirm"]}`;
}

const STAGES_ANALYZE = ["Analyzing prospect…", "Mapping responsibilities…", "Identifying pain points…", "Reading industry signals…", "Scoring fit…", "Building intelligence profile…"];
const STAGES_GEN = ["Analyzing prospect…", "Understanding industry…", "Identifying pain points…", "Building personalization…", "Generating outreach…", "Humanizing language…"];
const STAGES_ENRICH = ["Resolving URLs…", "Searching the web…", "Reading the company site…", "Extracting verified facts…", "Structuring intelligence…"];

function Loader({ stages }) {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((v) => Math.min(v + 1, stages.length - 1)), 950); return () => clearInterval(t); }, [stages]);
  return (
    <div className="loader">
      {stages.map((s, k) => (
        <div key={k} className={"lstage " + (k < i ? "done" : k === i ? "act" : "")}>
          <span className="ld">{k < i && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path d="M5 13l4 4L19 7" /></svg>}</span>{s}
        </div>
      ))}
    </div>
  );
}
const Ic = {
  hub: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>,
  intel: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>,
  conn: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>,
  rel: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  meet: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  fup: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/></svg>,
  rpa: <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><circle cx="12" cy="10" r="3"/><path d="M6 10h.01M18 10h.01"/></svg>,
};
const CopyIc = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
const RegenIc = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/></svg>;
const StarIc = (f) => <svg viewBox="0 0 24 24" fill={f ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>;

function MsgCard({ item, idx, kind, charLimit, favOn, onCopy, onRegen, onFav, regening }) {
  const over = charLimit && item.message && item.message.length > charLimit;
  return (
    <div className="mcard">
      <div className="mctop">
        <span className="chip idx">{String(idx + 1).padStart(2, "0")}</span>
        {item.angle && <span className="chip">{item.angle}</span>}
        {charLimit && <span className={"charc" + (over ? " over" : "")}>{(item.message || "").length}/{charLimit}</span>}
      </div>
      <div className="mbody">{item.message}</div>
      {(typeof item.personalization === "number" || typeof item.acceptance === "number") && (
        <div className="scores">
          {typeof item.personalization === "number" && (
            <div className="score"><div className="sl"><span>Personalization</span><b>{item.personalization}%</b></div><div className="bar"><i style={{ width: item.personalization + "%" }} /></div></div>
          )}
          {typeof item.acceptance === "number" && (
            <div className="score"><div className="sl"><span>{kind === "connection" ? "Acceptance" : kind === "relationship" ? "Reply odds" : "Meeting odds"}</span><b>{item.acceptance}%</b></div><div className="bar alt"><i style={{ width: item.acceptance + "%" }} /></div></div>
          )}
        </div>
      )}
      {item.reasoning && <div className="reason"><b>AI Coach</b> · {item.reasoning}</div>}
      <div className="mact">
        <button className="iconbtn" onClick={() => onCopy(item.message)}>{CopyIc} Copy</button>
        <button className="iconbtn" onClick={onRegen} disabled={regening}>{RegenIc} {regening ? "…" : "Regenerate"}</button>
        <button className={"iconbtn fav" + (favOn ? " on" : "")} onClick={onFav} style={{ marginLeft: "auto" }}>{StarIc(favOn)}</button>
      </div>
    </div>
  );
}

export default function KarmaConnectAI() {
  useEffect(() => {
    if (document.getElementById("kc-fonts")) return;
    const l = document.createElement("link"); l.id = "kc-fonts"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,500;0,600;0,700;1,500&family=Manrope:wght@400;500;600;700&display=swap";
    document.head.appendChild(l);
  }, []);

  // Restore saved work once (survives refresh, avoids re-billing). See save effect below.
  const [saved] = useState(() => {
    try { return JSON.parse(localStorage.getItem("kc_state_v1") || "{}") || {}; } catch (e) { return {}; }
  });
  const EMPTY_PROSPECT = {
    firstName: "", lastName: "", company: "", title: "", industry: "Property Restoration", location: "",
    headline: "", about: "", experience: "", website: "", companyDesc: "", news: "",
    notes: "", mutual: "", research: "", pain: "", growth: "", staffing: "", ops: "",
  };
  const [view, setView] = useState(saved.view || "hub");
  const [prospect, setProspect] = useState({ ...EMPTY_PROSPECT, ...(saved.prospect || {}) });
  const [sender, setSender] = useState(saved.sender || "nordon");
  const [offer, setOffer] = useState(saved.offer || senderOffer(SENDERS[0]));
  const [coUrl, setCoUrl] = useState(saved.coUrl || "");
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState("");
  const [enrichErr, setEnrichErr] = useState("");
  const [rawPaste, setRawPaste] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseMsg, setParseMsg] = useState("");
  const [parseErr, setParseErr] = useState("");
  const [analysis, setAnalysis] = useState(saved.analysis || null);
  const [results, setResults] = useState(saved.results || { connection: [], relationship: [], meeting_short: [], meeting_standard: [], meeting_executive: [], followup: [] });
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [regen, setRegen] = useState({});
  const [favs, setFavs] = useState(saved.favs || {});
  const [meetLen, setMeetLen] = useState(saved.meetLen || "standard");
  const [toast, setToast] = useState("");

  // Persist work to localStorage so a refresh never loses (or re-bills) it.
  useEffect(() => {
    try {
      localStorage.setItem("kc_state_v1", JSON.stringify({ view, prospect, sender, offer, coUrl, analysis, results, favs, meetLen }));
    } catch (e) {}
  }, [view, prospect, sender, offer, coUrl, analysis, results, favs, meetLen]);

  function pickSender(id) { const s = SENDERS.find((x) => x.id === id) || SENDERS[0]; setSender(id); setOffer(senderOffer(s)); }
  const set = (k, v) => setProspect((p) => ({ ...p, [k]: v }));
  const ready = prospect.firstName.trim() && (prospect.company.trim() || prospect.title.trim());
  const name = prospect.firstName || "this prospect";
  const initials = ((prospect.firstName[0] || "") + (prospect.lastName[0] || prospect.company[0] || "")).toUpperCase() || "·";
  function showToast(t) { setToast(t); setTimeout(() => setToast(""), 1600); }
  function copy(text) { navigator.clipboard && navigator.clipboard.writeText(text); showToast("Copied to clipboard"); }
  function resetAll() {
    if (!window.confirm("Clear this prospect and all generated messages? This cannot be undone.")) return;
    setProspect({ ...EMPTY_PROSPECT });
    setAnalysis(null);
    setResults({ connection: [], relationship: [], meeting_short: [], meeting_standard: [], meeting_executive: [], followup: [] });
    setFavs({}); setCoUrl(""); setRawPaste(""); setView("hub");
    setEnrichMsg(""); setEnrichErr(""); setParseMsg(""); setParseErr("");
    showToast("Cleared. Ready for a new prospect.");
  }
  const favKey = (kind, i, msg) => kind + ":" + i + ":" + (msg || "").slice(0, 24);
  function toggleFav(kind, i, msg) { const k = favKey(kind, i, msg); setFavs((f) => ({ ...f, [k]: !f[k] })); }

  // Lightweight COMPANY research — one web-search call. Fills empty company-side fields only.
  // (The person's profile comes from the Deep LinkedIn paste panel below.)
  async function enrich() {
    if (!coUrl.trim() && !prospect.company.trim()) {
      setEnrichErr("Add the company website URL or the company name first.");
      return;
    }
    setEnriching(true); setEnrichMsg(""); setEnrichErr("");
    try {
      const txt = await anthropicMsg(COMPANY_SYSTEM, companyResearchPrompt(prospect, coUrl), { maxTokens: 1200, useSearch: true });
      const parsed = safeJSON(txt);
      const d = Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
      const nv = (v) => (v == null || v === "NOT VERIFIED" ? "" : String(v).trim());
      const joinArr = (a, sep = ", ") => (Array.isArray(a) ? a.map(nv).filter(Boolean).join(sep) : "");
      setProspect((prev) => {
        const next = { ...prev };
        const fill = (k, val) => { if (val && !String(next[k] || "").trim()) next[k] = val; };
        fill("company", nv(d.company));
        fill("industry", nv(d.industry));
        fill("website", nv(d.website) || coUrl);
        fill("location", nv(d.location));
        fill("companyDesc", [nv(d.companyDesc), joinArr(d.services)].filter(Boolean).join(" | "));
        fill("news", joinArr((d.recentNews || []).slice(0, 3), " | "));
        const note = [nv(d.summary), nv(d.employeeCount) ? "Employees: " + nv(d.employeeCount) : ""].filter(Boolean).join(" ");
        if (note) next.research = (next.research ? next.research + "\n\n" : "") + "Company research: " + note;
        return next;
      });
      setEnrichMsg("Company research done. Filled the empty company fields I could verify. For the person's profile, use the Deep LinkedIn paste below.");
    } catch (e) {
      setEnrichErr((e && e.message) || "Couldn't research the company. You can still fill the fields manually.");
    }
    setEnriching(false);
  }

  async function parsePaste() {
    if (!rawPaste.trim()) return;
    setParsing(true); setParseMsg(""); setParseErr("");

    const systemPrompt = `You are an expert LinkedIn profile parser. You receive raw copy-pasted LinkedIn page text (Ctrl+A, Ctrl+C from a browser). The text contains the real profile mixed with LinkedIn UI noise: nav menus, ads, sidebars, "People also viewed", suggested connections, footer links, button labels, notification counts. Extract ONLY the actual profile data for the main person the page is about.

CRITICAL RULES:
- Return ONLY a single valid JSON object. No markdown. No code fences. No preamble. No commentary. Start your response with { and end with }.
- Every string value must be properly JSON-escaped. Escape all double quotes inside values as \\". Escape all newlines as \\n. Never use unescaped control characters inside string values.
- If a field has no data, use an empty string "". Never omit a field.
- For long fields like "about" and "experience": include ALL content, do not truncate. Use \\n to separate paragraphs and entries.
- "experience" should list every role as: TITLE at COMPANY (DATE_RANGE)\\nDescription if any. One entry per line.`;

    const userPrompt = `Extract every profile field from this raw LinkedIn page paste. Return a single JSON object with exactly these keys:
firstName, lastName, title, company, industry, location, headline, about, experience, education, skills, certifications, recommendations, recentPosts, mutualConnections, companyDesc, news, website, volunteering, languages, extraNotes, fieldsFound (array of field names you found data for), quality (high/medium/low string), qualityNote (one sentence string).

RAW PASTE:
${stripLinkedInNoise(rawPaste).slice(0, 14000)}`;

    try {
      const txt = await anthropicMsg(systemPrompt, userPrompt, { maxTokens: 4000 });

      let d;
      try {
        d = safeJSON(txt);
      } catch (parseErr) {
        const grab = (key) => { const m = txt.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1].replace(/\\n/g, "\n") : ""; };
        d = {
          firstName: grab("firstName"), lastName: grab("lastName"), title: grab("title"),
          company: grab("company"), industry: grab("industry"), location: grab("location"),
          headline: grab("headline"), about: grab("about"), experience: grab("experience"),
          education: grab("education"), skills: grab("skills"), certifications: grab("certifications"),
          recommendations: grab("recommendations"), recentPosts: grab("recentPosts"),
          mutualConnections: grab("mutualConnections"), companyDesc: grab("companyDesc"),
          news: grab("news"), website: grab("website"), volunteering: grab("volunteering"),
          languages: grab("languages"), extraNotes: grab("extraNotes"),
          fieldsFound: [], quality: "low", qualityNote: "Partial extraction due to response format issue.",
        };
        const anyFound = Object.values(d).some((v) => typeof v === "string" && v.trim().length > 0);
        if (!anyFound) throw new Error("Could not extract any profile data. Make sure you selected all text on the LinkedIn page (Ctrl+A then Ctrl+C) and try again.");
      }

      if (!d || typeof d !== "object") throw new Error("Unexpected response format. Try again.");
      const safeStr = (v) => (typeof v === "string" ? v.replace(/\\n/g, "\n").trim() : "");

      setProspect((p) => {
        const next = { ...p };
        ["firstName","lastName","title","company","industry","location","headline","about","experience","website","companyDesc","news"]
          .forEach((k) => { if (safeStr(d[k])) next[k] = safeStr(d[k]); });
        const extras = [];
        if (safeStr(d.education)) extras.push("Education: " + safeStr(d.education));
        if (safeStr(d.skills)) extras.push("Skills: " + safeStr(d.skills));
        if (safeStr(d.certifications)) extras.push("Certifications: " + safeStr(d.certifications));
        if (safeStr(d.volunteering)) extras.push("Volunteering: " + safeStr(d.volunteering));
        if (safeStr(d.languages)) extras.push("Languages: " + safeStr(d.languages));
        if (safeStr(d.extraNotes)) extras.push("Other: " + safeStr(d.extraNotes));
        if (extras.length) next.research = (next.research ? next.research + "\n\n" : "") + "From LinkedIn paste:\n" + extras.join("\n");
        const noteBlocks = [];
        if (safeStr(d.recommendations)) noteBlocks.push("Recommendations:\n" + safeStr(d.recommendations));
        if (safeStr(d.recentPosts)) noteBlocks.push("Recent posts / activity:\n" + safeStr(d.recentPosts));
        if (noteBlocks.length) next.notes = (next.notes ? next.notes + "\n\n" : "") + noteBlocks.join("\n\n");
        if (safeStr(d.mutualConnections)) next.mutual = (next.mutual ? next.mutual + " | " : "") + safeStr(d.mutualConnections);
        return next;
      });

      const found = Array.isArray(d.fieldsFound) ? d.fieldsFound.length : Object.values(d).filter((v) => typeof v === "string" && v.trim()).length;
      setParseMsg(`Profile parsed (${d.quality || "medium"} quality). ${found} fields extracted. ${d.qualityNote || ""} Review the fields below and fill in anything the AI missed.`);
      setRawPaste("");
    } catch (e) {
      setParseErr((e && e.message) || "Parse failed. Try Ctrl+A on the LinkedIn profile page, Ctrl+C, then paste here again.");
    }
    setParsing(false);
  }

  async function runAnalysis() {
    setLoading((l) => ({ ...l, analysis: true }));
    setErrors((e) => ({ ...e, analysis: null }));
    setView("intel");

    const systemPrompt = SYSTEM;
    const userPrompt = pAnalysis(buildContext(prospect, offer, null, ""));

    const attempt = async () => {
      const txt = await anthropicMsg(systemPrompt, userPrompt, { maxTokens: 2500 });
      if (!txt || !txt.trim()) throw new Error("Empty response from AI. Please try again.");
      return cleanMessages(safeJSON(txt));
    };

    try {
      // Try once; if parse fails, retry once automatically
      let result;
      try {
        result = await attempt();
      } catch (firstErr) {
        // One automatic retry before showing error
        result = await attempt();
      }
      setAnalysis(result);
    } catch (e) {
      setErrors((er) => ({ ...er, analysis: (e && e.message) || "Analysis failed. Try again." }));
    }
    setLoading((l) => ({ ...l, analysis: false }));
  }

  const TARGET = { connection: 10, relationship: 10, meeting_short: 10, meeting_standard: 10, meeting_executive: 10 };
  function builderFor(kind, n, avoid) {
    const base = buildContext(prospect, offer, analysis, "");
    if (kind === "connection") return pConnection(base, n, avoid);
    if (kind === "relationship") return pRelationship(base, n, avoid);
    if (kind.indexOf("meeting_") === 0) return pMeeting(base, n, kind.split("_")[1], avoid);
    return "";
  }
  async function generate(kind) {
    setLoading((l) => ({ ...l, [kind]: true })); setErrors((e) => ({ ...e, [kind]: null })); setResults((r) => ({ ...r, [kind]: [] }));
    try {
      if (kind === "followup") {
        const txt = await callClaude(SYSTEM, pFollowup(buildContext(prospect, offer, analysis, "")), false, 2800);
        let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr]; arr = cleanMessages(arr); setResults((r) => ({ ...r, followup: arr }));
      } else {
        const target = TARGET[kind] || 10;
        const isMeeting = kind.indexOf("meeting_") === 0;
        // Right-sized output cap to fit all `target` items in ONE call.
        const cap = isMeeting ? 4800 : kind === "relationship" ? 3600 : 3000;
        let acc = [], guard = 0;
        // Ask for ALL remaining items in a single call (collapses the old 2-4 call loop).
        // The loop only repeats if the model returned fewer than requested.
        while (acc.length < target && guard < 4) {
          guard++;
          const n = target - acc.length;
          const avoid = acc.map((x) => x.angle).filter(Boolean);
          const txt = await callClaude(SYSTEM, builderFor(kind, n, avoid), false, cap);
          let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr];
          arr = arr.filter((x) => x && x.message);
          arr = cleanMessages(arr);
          if (!arr.length) break;
          acc = acc.concat(arr); setResults((r) => ({ ...r, [kind]: [...acc] }));
        }
        if (!acc.length) throw new Error("No messages came back. Please try again.");
      }
    } catch (e) { setErrors((er) => ({ ...er, [kind]: e.message })); }
    setLoading((l) => ({ ...l, [kind]: false }));
  }
  async function regenerateOne(kind, i) {
    const rk = kind + i; setRegen((r) => ({ ...r, [rk]: true }));
    try {
      const avoid = results[kind].filter((_, k) => k !== i).map((x) => x.angle).filter(Boolean);
      const txt = await callClaude(SYSTEM, builderFor(kind, 1, avoid));
      let arr = safeJSON(txt); if (!Array.isArray(arr)) arr = [arr]; arr = cleanMessages(arr);
      const item = arr.find((x) => x && x.message);
      if (item) setResults((r) => { const c = [...r[kind]]; c[i] = item; return { ...r, [kind]: c }; });
      else showToast("Regenerate failed — try again");
    } catch (e) { showToast("Regenerate failed — try again"); }
    setRegen((r) => ({ ...r, [rk]: false }));
  }

  const NAV = [
    { id: "hub", label: "Prospect Hub", ic: Ic.hub },
    { id: "intel", label: "Intelligence", ic: Ic.intel, gate: true },
    { id: "connection", label: "Connection Requests", ic: Ic.conn, gate: true, count: results.connection.length },
    { id: "relationship", label: "Relationship Builder", ic: Ic.rel, gate: true, count: results.relationship.length },
    { id: "meeting", label: "Meeting Requests", ic: Ic.meet, gate: true },
    { id: "followup", label: "Follow-up Engine", ic: Ic.fup, gate: true, count: results.followup.length },
  ];

  function ProspectStrip() {
    return (
      <div className="pchip">
        <span className="av">{initials}</span>
        <span>
          <div className="pn">{[prospect.firstName, prospect.lastName].filter(Boolean).join(" ") || "Unnamed prospect"}</div>
          <div className="pr">{[prospect.title, prospect.company].filter(Boolean).join(" · ") || prospect.industry}</div>
        </span>
      </div>
    );
  }
  function Field({ k, label, ph, area, full }) {
    return (
      <div className={"f" + (full ? " full" : "")}>
        <label>{label}</label>
        {area ? <textarea value={prospect[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} />
              : <input value={prospect[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} />}
      </div>
    );
  }
  function SectionGenerator({ kind, title, eyebrow, blurb, charLimit }) {
    const items = results[kind] || [], isLoad = loading[kind], err = errors[kind];
    return (
      <div>
        <div className="head"><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{blurb}</p></div>
        <ProspectStrip />
        <div className="toprow">
          <button className="btn primary" onClick={() => generate(kind)} disabled={isLoad}>{isLoad ? "Generating…" : items.length ? "Regenerate all" : "Generate 10 variations"}</button>
          {items.length > 0 && !isLoad && <span style={{ color: "var(--muted)", fontSize: 13 }}>{items.length} crafted for {name}</span>}
        </div>
        {err && <div className="err" style={{ marginBottom: 16 }}>⚠ {err}</div>}
        {isLoad && items.length === 0 && <div className="panel"><Loader stages={STAGES_GEN} /></div>}
        {!isLoad && items.length === 0 && !err && (
          <div className="empty"><div className="eic">{Ic.conn}</div><h3>No messages yet</h3><p>{blurb}</p><button className="btn primary" onClick={() => generate(kind)}>Generate for {name}</button></div>
        )}
        {items.length > 0 && (
          <div className="grid2">
            {items.map((it, i) => (
              <MsgCard key={i} item={it} idx={i} kind={kind} charLimit={charLimit}
                favOn={!!favs[favKey(kind, i, it.message)]} onCopy={copy} onFav={() => toggleFav(kind, i, it.message)}
                onRegen={() => regenerateOne(kind, i)} regening={!!regen[kind + i]} />
            ))}
            {isLoad && <div className="mcard" style={{ justifyContent: "center", alignItems: "center", minHeight: 120, color: "var(--muted)", fontSize: 13 }}>Crafting more…</div>}
          </div>
        )}
      </div>
    );
  }

  const fitRows = analysis && analysis.fit ? [["ICP Fit", analysis.fit.icp], ["Qualification", analysis.fit.qualification], ["Buying readiness", analysis.fit.readiness]] : [];

  return (
    <div className="kc">
      <style>{CSS}</style>
      <div className="app">
        <aside className="side">
          <div className="brand">
            <span className="mark"><KarmaMark color="#fff" w={22} /></span>
            <div><h1>Karma <b>Connect</b></h1><span>AI Prospecting</span></div>
          </div>
          <div className="navlbl">Workspace</div>
          {NAV.map((n) => {
            const locked = n.gate && !analysis && !loading.analysis;
            return (
              <button key={n.id} className={"nav" + (view === n.id ? " on" : "") + (locked ? " lock" : "")} onClick={() => { if (!locked) setView(n.id); }}>
                {n.ic}{n.label}
                {n.count > 0 && <span className="ct">{n.count}</span>}
                {locked && <span className="ct" style={{ color: "var(--faint)" }}>🔒</span>}
              </button>
            );
          })}
          <div className="sidefoot">
            <div><span className="dot" />{analysis ? "Profile active" : "Awaiting analysis"}</div>
            <div style={{ marginTop: 6, opacity: .85 }}>Sending as <b style={{ color: "var(--ice)" }}>{(SENDERS.find((s) => s.id === sender) || SENDERS[0]).name}</b></div>
            <div style={{ marginTop: 6, opacity: .7 }}>Brand DNA · live generation</div>
          </div>
        </aside>

        <main className="main">
          {toast && <div style={{ position: "fixed", top: 22, left: "50%", transform: "translateX(-50%)", zIndex: 50, background: "var(--bg3)", border: "1px solid var(--border2)", padding: "10px 18px", borderRadius: 12, fontSize: 13, fontWeight: 600 }}>{toast}</div>}

          {view === "hub" && (
            <div>
              <div className="head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                <div><div className="eyebrow">Prospect Intelligence Hub</div><h2>Tell the AI about your prospect</h2><p>Research the company website, paste the prospect's LinkedIn page, or enter details by hand. The richer the input, the more the outreach reads as personally written. Then run analysis to unlock the engines. Your work is saved automatically and survives a refresh.</p></div>
                <button className="btn ghost sm" onClick={resetAll} style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}>New prospect</button>
              </div>
              <div className="fa">
                <div className="panel" style={{ borderColor: "var(--border2)" }}>
                  <div className="sect-title">Company research · enter the company website, AI fills the company fields</div>
                  <div className="fgrid">
                    <div className="f"><label>Company website URL</label><input value={coUrl} placeholder="https://company.com" onChange={(e) => setCoUrl(e.target.value)} /></div>
                  </div>
                  <div className="toprow" style={{ marginTop: 14 }}>
                    <button className="btn primary" onClick={enrich} disabled={enriching || (!coUrl && !prospect.company.trim())}>{enriching ? "Researching…" : "Research company & fill ↓"}</button>
                    <span style={{ color: "var(--muted)", fontSize: 12.5 }}>One quick web-search pass on the company. Fills empty company fields only, never overwrites what you typed.</span>
                  </div>
                  {enriching && <div className="panel" style={{ marginTop: 14 }}><Loader stages={["Reading the company site…", "Searching the web…", "Extracting company facts…"]} /></div>}
                  {enrichMsg && <div className="reason" style={{ marginTop: 12 }}><b>Done</b> · {enrichMsg}</div>}
                  {enrichErr && <div className="err" style={{ marginTop: 12 }}>⚠ {enrichErr}</div>}
                  <div className="hint" style={{ marginTop: 10 }}>⚠ For the person's profile (name, title, about, experience), use the Deep LinkedIn paste panel below, that's the most complete and lowest-cost way to import a profile.</div>
                </div>

                <div className="panel" style={{ borderColor: "rgba(255,207,0,.22)", background: "rgba(255,207,0,.03)" }}>
                  <div className="sect-title" style={{ color: "var(--yellow)" }}>Deep LinkedIn paste · the most complete way to import a profile</div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14, lineHeight: 1.65 }}>
                    Open the LinkedIn profile in your browser while logged in. Press <b style={{ color: "var(--text)" }}>Ctrl+A</b> (select all) then <b style={{ color: "var(--text)" }}>Ctrl+C</b> (copy). Paste everything below. The AI will extract every field including full About, all Experience entries, Education, Skills, Certifications, recent posts, recommendations, and mutual connections.
                  </div>
                  <div className="f full" style={{ marginBottom: 14 }}>
                    <label>Raw LinkedIn page paste — Ctrl+A on the profile page, Ctrl+C, paste here</label>
                    <textarea
                      value={rawPaste}
                      onChange={(e) => setRawPaste(e.target.value)}
                      placeholder={"Paste the full LinkedIn page text here...\n\nTip: on the profile page press Ctrl+A to select everything, then Ctrl+C to copy, then click here and Ctrl+V. It will look messy — that is fine, the AI knows how to parse it."}
                      style={{ minHeight: 140, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }}
                    />
                  </div>
                  {rawPaste.trim().length > 0 && (
                    <div style={{ fontSize: 12, color: "var(--faint)", marginBottom: 12 }}>
                      {rawPaste.length.toLocaleString()} characters pasted
                    </div>
                  )}
                  <div className="toprow" style={{ marginTop: 0 }}>
                    <button className="btn primary" onClick={parsePaste} disabled={parsing || !rawPaste.trim()}>
                      {parsing ? "Parsing profile…" : "Parse & fill all fields ↓"}
                    </button>
                    <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Overwrites all fields with what it finds — most complete data source available.</span>
                  </div>
                  {parsing && <div className="panel" style={{ marginTop: 14 }}><Loader stages={["Reading raw paste…","Stripping LinkedIn UI noise…","Extracting profile fields…","Parsing experience history…","Capturing posts and signals…","Structuring all data…"]} /></div>}
                  {parseMsg && <div className="reason" style={{ marginTop: 12 }}><b>Done</b> · {parseMsg}</div>}
                  {parseErr && <div className="err" style={{ marginTop: 12 }}>⚠ {parseErr}</div>}
                </div>

                <div className="panel">
                  <div className="sect-title">Basic information</div>
                  <div className="fgrid">
                    <Field k="firstName" label="First name" ph="e.g. Jeremy" />
                    <Field k="lastName" label="Last name" ph="e.g. Berg" />
                    <Field k="company" label="Company" ph="e.g. Armor Restoration" />
                    <Field k="title" label="Job title" ph="e.g. Owner / Operations Director" />
                    <Field k="industry" label="Industry" ph="e.g. Property Restoration" />
                    <Field k="location" label="Location" ph="e.g. Dallas, TX" />
                  </div>
                </div>
                <div className="panel">
                  <div className="sect-title">Research information</div>
                  <div className="fgrid">
                    <Field k="headline" label="LinkedIn headline" ph="Their headline" full />
                    <Field k="about" label="LinkedIn about section" ph="Paste their About text" area full />
                    <Field k="experience" label="LinkedIn experience" ph="Key roles, tenure, background" area full />
                    <Field k="website" label="Company website" ph="armorrestoration.com" />
                    <Field k="news" label="Recent news / signals" ph="Expansion, hiring, storm season, etc." />
                    <Field k="companyDesc" label="Company description" ph="What the company does" area full />
                    <Field k="mutual" label="Mutual interests" ph="Shared groups, alma mater, hobbies" />
                    <Field k="notes" label="Personal notes" ph="Anything personal you noticed" />
                    <Field k="research" label="Additional research" ph="Anything else relevant" area full />
                  </div>
                </div>
                <div className="panel">
                  <div className="sect-title">Optional AI context</div>
                  <div className="fgrid">
                    <Field k="pain" label="Pain points" ph="Known frustrations" />
                    <Field k="growth" label="Growth objectives" ph="Where they're trying to grow" />
                    <Field k="staffing" label="Staffing challenges" ph="Hiring / capacity issues" />
                    <Field k="ops" label="Operational challenges" ph="Process / margin / backlog issues" />
                  </div>
                </div>

                <div className="panel">
                  <div className="sect-title">Sending as</div>
                  <div className="senders">
                    {SENDERS.map((s) => (
                      <button key={s.id} className={"sbtn" + (sender === s.id ? " on" : "")} onClick={() => pickSender(s.id)}>
                        <span className="sn">{s.name}</span><span className="sr">{s.role}</span><span className="st">{s.tag}</span>
                      </button>
                    ))}
                  </div>
                  <div className="f full">
                    <label>The AI writes in this sender's voice, uses only these real facts, and signs off with their first name. Meeting &amp; follow-up CTAs use their calendar link. Switching sender reloads the template.</label>
                    <textarea value={offer} onChange={(e) => setOffer(e.target.value)} style={{ minHeight: 120 }} />
                  </div>
                </div>

                {!ready && <div className="hint">⚠ Add at least a first name and a company or title to continue.</div>}
                <div className="toprow">
                  <button className="btn primary" disabled={!ready || loading.analysis} onClick={runAnalysis}>{loading.analysis ? "Analyzing…" : "Run AI Analysis →"}</button>
                  <span style={{ color: "var(--muted)", fontSize: 13 }}>Builds an intelligence profile + fit scores, then unlocks all message engines.</span>
                </div>
              </div>
            </div>
          )}

          {view === "intel" && (
            <div>
              <div className="head"><div className="eyebrow">AI Analysis Engine</div><h2>Intelligence profile</h2><p>What the AI understands about {name} before writing a word. This drives every message.</p></div>
              <ProspectStrip />
              {loading.analysis && <div className="panel"><Loader stages={STAGES_ANALYZE} /></div>}
              {errors.analysis && <div className="err">⚠ {errors.analysis}</div>}
              {analysis && !loading.analysis && (
                <div className="iprofile">
                  <div className="iblock full"><h4>Who they are</h4><p>{analysis.persona}</p></div>
                  {fitRows.length > 0 && (
                    <div className="iblock full">
                      <h4>Fit &amp; opportunity scoring</h4>
                      <div className="fitgrid">
                        {fitRows.map(([label, v], i) => v ? (
                          <div className="fitcard" key={i}>
                            <div className="fh"><span className="fn">{label}</span><span className="fv">{v.score}</span></div>
                            <div className="bar gold"><i style={{ width: (v.score || 0) + "%" }} /></div>
                            <div className="fc">{v.confidence} confidence</div>
                            <div className="fw">{v.why}</div>
                          </div>
                        ) : null)}
                      </div>
                    </div>
                  )}
                  {[["Likely responsibilities", analysis.responsibilities], ["Pain points", analysis.painPoints], ["Goals they're pursuing", analysis.goals], ["Connection angles", analysis.hooks], ["Industry trends", analysis.trends], ["Sector challenges", analysis.challenges]].map(([t, arr], i) =>
                    arr && arr.length ? <div className="iblock" key={i}><h4>{t}</h4><ul>{arr.map((x, k) => <li key={k}>{x}</li>)}</ul></div> : null
                  )}
                  <div className="iblock full" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--muted)", fontSize: 13.5 }}>Profile ready — the engines are unlocked. Start with a connection request.</span>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button className="btn ghost sm" onClick={runAnalysis}>Re-run analysis</button>
                      <button className="btn primary sm" onClick={() => setView("connection")}>Connection requests →</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {view === "connection" && <SectionGenerator kind="connection" eyebrow="Section 01 · Most important" title="LinkedIn connection requests" blurb="Personalized invite notes under 300 characters. No pitch, no selling, no meeting ask — the only goal is an accepted connection that feels genuinely personal." charLimit={300} />}
          {view === "relationship" && <SectionGenerator kind="relationship" eyebrow="Section 02 · After they accept" title="Post-connection relationship builder" blurb="Relationship-first openers that start a real conversation and demonstrate relevance — built to earn a reply, not to pitch." />}

          {view === "meeting" && (
            <div>
              <div className="head"><div className="eyebrow">Section 03 · Once rapport is built</div><h2>Meeting request generator</h2><p>Value-focused, non-salesy meeting requests that make the ask an easy yes. Choose a length, then generate 10 angles.</p></div>
              <ProspectStrip />
              <div className="toprow">
                <div className="seg">{[["short", "Short"], ["standard", "Standard"], ["executive", "Executive"]].map(([v, l]) => <button key={v} className={meetLen === v ? "on" : ""} onClick={() => setMeetLen(v)}>{l}</button>)}</div>
                <button className="btn primary" onClick={() => generate("meeting_" + meetLen)} disabled={loading["meeting_" + meetLen]}>{loading["meeting_" + meetLen] ? "Generating…" : (results["meeting_" + meetLen].length ? "Regenerate" : "Generate 10")}</button>
              </div>
              {errors["meeting_" + meetLen] && <div className="err" style={{ marginBottom: 16 }}>⚠ {errors["meeting_" + meetLen]}</div>}
              {loading["meeting_" + meetLen] && results["meeting_" + meetLen].length === 0 && <div className="panel"><Loader stages={STAGES_GEN} /></div>}
              {!loading["meeting_" + meetLen] && results["meeting_" + meetLen].length === 0 && !errors["meeting_" + meetLen] && (
                <div className="empty"><div className="eic">{Ic.meet}</div><h3>No {meetLen} meeting requests yet</h3><p>Generate 10 personalized {meetLen} meeting requests for {name}.</p><button className="btn primary" onClick={() => generate("meeting_" + meetLen)}>Generate for {name}</button></div>
              )}
              {results["meeting_" + meetLen].length > 0 && (
                <div className="grid2">
                  {results["meeting_" + meetLen].map((it, i) => { const kind = "meeting_" + meetLen; return <MsgCard key={i} item={it} idx={i} kind="meeting" favOn={!!favs[favKey(kind, i, it.message)]} onCopy={copy} onFav={() => toggleFav(kind, i, it.message)} onRegen={() => regenerateOne(kind, i)} regening={!!regen[kind + i]} />; })}
                  {loading["meeting_" + meetLen] && <div className="mcard" style={{ justifyContent: "center", alignItems: "center", minHeight: 120, color: "var(--muted)", fontSize: 13 }}>Crafting more…</div>}
                </div>
              )}
            </div>
          )}

          {view === "followup" && (
            <div>
              <div className="head"><div className="eyebrow">Section 04 · No reply yet</div><h2>Intelligent follow-up engine</h2><p>A 5-step sequence where every message introduces something new — never "just checking in," never a repeat.</p></div>
              <ProspectStrip />
              <div className="toprow"><button className="btn primary" onClick={() => generate("followup")} disabled={loading.followup}>{loading.followup ? "Generating…" : (results.followup.length ? "Regenerate sequence" : "Generate sequence")}</button></div>
              {errors.followup && <div className="err" style={{ marginBottom: 16 }}>⚠ {errors.followup}</div>}
              {loading.followup && <div className="panel"><Loader stages={STAGES_GEN} /></div>}
              {!loading.followup && results.followup.length === 0 && !errors.followup && (
                <div className="empty"><div className="eic">{Ic.fup}</div><h3>No sequence yet</h3><p>Generate a 5-step follow-up sequence tailored to {name}.</p><button className="btn primary" onClick={() => generate("followup")}>Generate sequence</button></div>
              )}
              {results.followup.length > 0 && (
                <div className="tline">
                  {results.followup.map((st, i) => { const kind = "followup"; return (
                    <div className="titem" key={i}>
                      <div className="mcard">
                        <div className="mctop"><span className="chip idx">{i + 1}</span><span className="stagehd">{st.stage}</span></div>
                        <div className="mbody">{st.message}</div>
                        {st.fresh && <div className="reason"><b>New angle</b> · {st.fresh}</div>}
                        {st.reasoning && <div className="reason"><b>AI Coach</b> · {st.reasoning}</div>}
                        <div className="mact">
                          <button className="iconbtn" onClick={() => copy(st.message)}>{CopyIc} Copy</button>
                          <button className={"iconbtn fav" + (favs[favKey(kind, i, st.message)] ? " on" : "")} onClick={() => toggleFav(kind, i, st.message)} style={{ marginLeft: "auto" }}>{StarIc(!!favs[favKey(kind, i, st.message)])}</button>
                        </div>
                      </div>
                    </div>
                  ); })}
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
