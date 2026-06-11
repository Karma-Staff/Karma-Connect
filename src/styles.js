// All app styling, injected once via a <style> tag in the root component.
export const CSS = `
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
.kc .rpa-phase{display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--border); font-size:13px}
.kc .rpa-phase:last-child{border-bottom:none}
.kc .rpa-phase .ph-num{width:26px; height:26px; border-radius:8px; background:var(--panel2); border:1px solid var(--border2); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; color:var(--ice); flex:0 0 26px}
.kc .rpa-phase .ph-num.act{background:rgba(74,134,200,.25); border-color:var(--steel); color:var(--text); animation:pulse 1.2s ease infinite}
.kc .rpa-phase .ph-num.done{background:rgba(82,211,158,.18); border-color:rgba(82,211,158,.4); color:#52d39e}
.kc .rpa-phase .ph-lbl{font-weight:600; color:var(--muted)}
.kc .rpa-phase .ph-lbl.act{color:var(--text)}
.kc .rpa-phase .ph-status{margin-left:auto; font-size:11px; color:var(--faint); font-weight:600}
.kc .rpa-phase .ph-status.act{color:var(--steel)}
.kc .rpa-phase .ph-status.done{color:#52d39e}
`;
