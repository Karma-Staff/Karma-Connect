import { useState, useEffect, useRef, cloneElement } from "react";
import { signIn, signUp, signOut, currentUser, onAuthChange, refreshUser, authAvailable, resendVerification, requestPasswordReset, resetPassword } from "../lib/auth.js";
import { hasPassword, setPassword as setLocalPw, verifyPassword, clearPassword } from "../lib/localpass.js";
import { KarmaIcon } from "./icons.jsx";

const LS_KEY = "kc_email";
const EMAIL_RE = /\S+@\S+\.\S+/;

const AUTH_CSS = `
.kcauth{position:fixed; inset:0; overflow-x:hidden; overflow-y:auto; display:flex; align-items:flex-start; justify-content:center; padding:28px;
  color:#eef2fb; letter-spacing:-.01em;
  font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'SF Pro Display','Segoe UI',sans-serif;
  background:
    radial-gradient(1100px 760px at 78% 16%, rgba(124,92,255,.18), transparent 55%),
    radial-gradient(900px 680px at 8% 92%, rgba(231,183,75,.11), transparent 55%),
    radial-gradient(700px 600px at 50% 50%, rgba(74,134,200,.06), transparent 60%),
    linear-gradient(160deg, #071426 0%, #081B38 46%, #020B1C 100%);}
.kcauth *{box-sizing:border-box}
.kcauth .net{position:absolute; inset:0; pointer-events:none; opacity:.5}
.kcauth .pdot{position:absolute; width:4px; height:4px; border-radius:50%; background:rgba(160,140,255,.8); box-shadow:0 0 10px rgba(124,92,255,.9); animation:kcfloat 7s ease-in-out infinite}
.kcauth .pdot.g{background:rgba(231,183,75,.85); box-shadow:0 0 10px rgba(231,183,75,.9)}
@keyframes kcfloat{0%,100%{transform:translateY(-6px); opacity:.5}50%{transform:translateY(8px); opacity:1}}
.kcauth .center{position:relative; z-index:2; width:100%; max-width:540px; margin:auto; animation:kcrise .6s cubic-bezier(.22,1,.36,1) both}
@keyframes kcrise{from{opacity:0; transform:translateY(16px)}to{opacity:1; transform:none}}
.kcauth .brand{text-align:center; margin-bottom:26px}
/* The icon asset is itself a bevelled navy tile, so this box no longer draws one — otherwise
   you get a tile inside a tile. It keeps only the size and the glow, via drop-shadow so the
   glow follows the icon's rounded silhouette rather than a square box. */
.kcauth .brand .mk{width:62px; height:62px; margin:0 auto 16px; display:flex; align-items:center; justify-content:center}
.kcauth .brand .mk .kicon{width:100%; height:100%; object-fit:contain; display:block;
  filter:drop-shadow(0 16px 34px rgba(124,92,255,.5))}
.kcauth .brand h1{font-family:'Manrope',ui-sans-serif,system-ui,sans-serif; font-size:27px; font-weight:800; letter-spacing:-.02em}
.kcauth .brand h1 b{background:linear-gradient(135deg,#FFD83A,#E7B74B); -webkit-background-clip:text; background-clip:text; color:transparent; font-weight:800}
.kcauth .brand p{margin-top:7px; font-size:13px; font-weight:500; color:#8fa0c4; letter-spacing:.04em}
.kcauth .card{position:relative; padding:34px 36px; border-radius:20px;
  background:linear-gradient(150deg, rgba(255,255,255,.07), rgba(255,255,255,.02) 42%, rgba(255,255,255,.012) 100%);
  border:1px solid rgba(140,160,220,.18);
  backdrop-filter:blur(26px) saturate(1.4); -webkit-backdrop-filter:blur(26px) saturate(1.4);
  box-shadow:0 40px 90px -42px rgba(0,0,0,.9), 0 0 0 1px rgba(124,92,255,.06), inset 0 1px 0 rgba(255,255,255,.14)}
.kcauth .card:before{content:""; position:absolute; inset:-1px; border-radius:20px; pointer-events:none;
  background:linear-gradient(135deg, rgba(124,92,255,.35), transparent 30%, transparent 70%, rgba(231,183,75,.22)); -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; padding:1px}
.kcauth h2{font-size:24px; font-weight:700; text-align:center; letter-spacing:-.02em}
.kcauth .sub{text-align:center; color:#9aa7c4; font-size:13.5px; margin-top:8px; margin-bottom:24px; line-height:1.5}
.kcauth label{display:block; font-size:12px; font-weight:600; color:#aeb9d6; margin:0 0 7px 2px}
.kcauth .field{position:relative; margin-bottom:15px}
.kcauth .field .ic{position:absolute; left:14px; top:50%; transform:translateY(-50%); color:#9fb2e0; display:flex; pointer-events:none; z-index:2}
.kcauth .field .ic svg{width:18px; height:18px}
.kcauth .field input{position:relative; z-index:1; width:100%; height:48px; padding:0 44px 0 42px; border-radius:13px; font-size:14px; color:#eef2fb; outline:none;
  background:rgba(3,9,22,.55); border:1px solid rgba(140,160,220,.18); transition:border .18s, box-shadow .18s, background .18s; font-family:inherit}
.kcauth .field input::placeholder{color:#4d5d84}
.kcauth .field input:focus{border-color:rgba(124,92,255,.6); background:rgba(3,9,22,.7); box-shadow:0 0 0 4px rgba(124,92,255,.16)}
.kcauth .field:focus-within .ic{color:#c3d2f7}
/* Stop the browser autofill from painting an opaque (light) background over the field and hiding the icon. */
.kcauth .field input:-webkit-autofill,
.kcauth .field input:-webkit-autofill:hover,
.kcauth .field input:-webkit-autofill:focus{
  -webkit-text-fill-color:#eef2fb; caret-color:#eef2fb;
  -webkit-box-shadow:0 0 0 1000px #0a1730 inset; box-shadow:0 0 0 1000px #0a1730 inset;
  transition:background-color 9999s ease-in-out 0s;}
.kcauth .field .eye{position:absolute; right:10px; top:50%; transform:translateY(-50%); background:none; border:none; color:#5f72a0; cursor:pointer; padding:6px; display:flex; border-radius:8px}
.kcauth .field .eye:hover{color:#cfe0f6}
.kcauth .row2{display:grid; grid-template-columns:1fr 1fr; gap:12px}
.kcauth .util{display:flex; align-items:center; justify-content:space-between; margin:4px 0 20px; font-size:12.5px}
.kcauth .util .rm{display:flex; align-items:center; gap:8px; color:#aeb9d6; cursor:pointer; user-select:none}
.kcauth .util .rm .box{width:17px; height:17px; border-radius:6px; border:1px solid rgba(140,160,220,.4); background:rgba(3,9,22,.5); display:flex; align-items:center; justify-content:center; color:#071226}
.kcauth .util .rm .box.on{background:linear-gradient(135deg,#FFD83A,#E7B74B); border-color:transparent}
.kcauth .util .lk{background:none; border:none; color:#9b7cff; cursor:pointer; font-weight:600; font-size:12.5px; font-family:inherit; padding:0}
.kcauth .util .lk:hover{color:#b8a3ff}
.kcauth .cta{width:100%; height:50px; border:none; border-radius:13px; cursor:pointer; font-family:inherit; font-weight:700; font-size:14.5px; color:#071226;
  background:linear-gradient(135deg,#FFD83A 0%,#FFCF00 45%,#E7B74B 100%);
  box-shadow:0 18px 40px -16px rgba(231,183,75,.7), inset 0 1px 0 rgba(255,255,255,.5); transition:transform .22s ease, box-shadow .22s ease; letter-spacing:-.01em}
.kcauth .cta:hover:not(:disabled){transform:translateY(-2px); box-shadow:0 26px 54px -14px rgba(231,183,75,.92), inset 0 1px 0 rgba(255,255,255,.6)}
.kcauth .cta:disabled{opacity:.6; cursor:default}
.kcauth .msg{font-size:12.5px; margin-top:14px; line-height:1.5}
.kcauth .msg.err{color:#ffb3b3}
.kcauth .msg.ok{color:#bfe6ff}
.kcauth .foot{text-align:center; margin-top:22px; padding-top:20px; border-top:1px solid rgba(140,160,220,.14); font-size:13px; color:#9aa7c4}
.kcauth .foot .lk{background:none; border:none; cursor:pointer; font-family:inherit; font-size:13px; font-weight:700; padding:0;
  background:linear-gradient(135deg,#FFD83A,#E7B74B); -webkit-background-clip:text; background-clip:text; color:transparent}
.kcauth :focus-visible{outline:2px solid rgba(155,124,255,.7); outline-offset:2px}
@media(max-width:560px){ .kcauth .card{padding:28px 22px} .kcauth .row2{grid-template-columns:1fr} }

/* ═══════ Crystal / lightning upgrade (matches the workspace) ═══════ */
/* Drifting ambient aurora behind the login. */
.kcauth:after{content:""; position:absolute; inset:-25%; z-index:0; pointer-events:none; opacity:.6; filter:blur(30px);
  background:
    radial-gradient(36% 30% at 20% 22%, rgba(124,92,255,.30), transparent 60%),
    radial-gradient(32% 28% at 80% 30%, rgba(74,134,200,.22), transparent 60%),
    radial-gradient(40% 34% at 60% 86%, rgba(231,183,75,.16), transparent 62%);
  animation:authAurora 20s ease-in-out infinite alternate}
@keyframes authAurora{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(3%,-2%,0) scale(1.08)}100%{transform:translate3d(-3%,2%,0) scale(1.05)}}
/* keep particles + network above the aurora veil, content above all */
.kcauth .net,.kcauth .pdot{z-index:1}
.kcauth .center{z-index:3}
/* Violet halo + brighter mark glow. */
.kcauth .card{box-shadow:0 40px 90px -42px rgba(0,0,0,.9), 0 0 0 1px rgba(124,92,255,.08), 0 0 70px -30px rgba(124,92,255,.45), inset 0 1px 0 rgba(255,255,255,.14)}
.kcauth .brand .mk .kicon{filter:drop-shadow(0 16px 34px rgba(124,92,255,.55)) drop-shadow(0 0 22px rgba(124,92,255,.4))}
/* Lightning sweep across the main button on hover. */
.kcauth .cta{position:relative; overflow:hidden}
.kcauth .cta:after{content:""; position:absolute; top:-20%; left:-70%; width:45%; height:140%; transform:skewX(-22deg);
  background:linear-gradient(90deg, transparent, rgba(255,255,255,.6), transparent); pointer-events:none}
.kcauth .cta:hover:not(:disabled):after{animation:authSweep .8s ease}
@keyframes authSweep{from{left:-70%}to{left:130%}}
.kcauth .cta:hover:not(:disabled){box-shadow:0 26px 54px -14px rgba(231,183,75,.95), 0 0 36px -6px rgba(255,207,0,.55), inset 0 1px 0 rgba(255,255,255,.6)}
@media(prefers-reduced-motion:reduce){ .kcauth:after,.kcauth .cta:after{animation:none} }

/* Liquid glass: thicker frost + glossy sheen on the card and frosted inputs. */
.kcauth .card{-webkit-backdrop-filter:blur(38px) saturate(185%); backdrop-filter:blur(38px) saturate(185%);
  background:linear-gradient(150deg, rgba(255,255,255,.16), rgba(255,255,255,.05) 42%, rgba(255,255,255,.02) 100%)}
.kcauth .card>*{position:relative; z-index:1}
.kcauth .card:after{content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none; z-index:0;
  background:radial-gradient(130% 90% at 12% -12%, rgba(255,255,255,.28), rgba(255,255,255,0) 46%), linear-gradient(180deg, rgba(255,255,255,.1), rgba(255,255,255,0) 20%); opacity:.8}
.kcauth .field input{background:rgba(255,255,255,.06); border-color:rgba(140,160,220,.22);
  -webkit-backdrop-filter:blur(10px) saturate(1.4); backdrop-filter:blur(10px) saturate(1.4)}
.kcauth .field input:focus{background:rgba(255,255,255,.1); box-shadow:0 0 0 4px rgba(124,92,255,.18), inset 0 1px 0 rgba(255,255,255,.25)}

/* ── Cinematic stick-figure handshake intro ── */
.kcauth-intro{position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center; cursor:pointer; overflow:hidden;
  background:radial-gradient(900px 700px at 50% 42%, rgba(22,56,90,.55), transparent 60%), linear-gradient(160deg,#071426 0%,#081B38 50%,#020B1C 100%);
  animation:kcIntroOut .7s ease 3.7s both}
.kcauth-intro .stage{position:relative; width:min(560px,88vw); display:flex; align-items:center; justify-content:center}
.kcauth-intro svg{width:100%; height:auto; transform-origin:50% 54%; animation:kcIntroZoom 3.7s cubic-bezier(.55,0,.2,1) both}
.kcauth-intro .hands{transform-origin:50% 54%; animation:kcHandshake .26s ease-in-out 5 alternate}
/* Green-screen clip: the green is keyed out per-pixel onto a canvas (see ChromaVideo), so the
   hands arrive with real transparency and need no blend mode. */
.kcauth-intro .vid{display:block; width:min(640px,92vw); height:auto; max-height:76vh; object-fit:contain; transform-origin:50% 50%;
  animation:kcVidZoom 3.7s cubic-bezier(.55,0,.2,1) both}
@keyframes kcVidZoom{0%{transform:scale(1.55)}60%{transform:scale(1)}100%{transform:scale(1)}}
.kcauth-intro .figs{animation:kcFigsFade .7s ease 2.6s both}
.kcauth-intro .logo{position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:15px; opacity:0; animation:kcLogoReveal .9s cubic-bezier(.22,1,.36,1) 2.6s both}
.kcauth-intro .logo .mk{width:88px; height:88px; display:flex; align-items:center; justify-content:center}
.kcauth-intro .logo .mk .kicon{width:100%; height:100%; object-fit:contain; display:block;
  filter:drop-shadow(0 18px 44px rgba(124,92,255,.6))}
.kcauth-intro .logo h1{font-family:'Lora',serif; font-size:30px; font-weight:700; color:#eef2fb; letter-spacing:-.02em}
.kcauth-intro .logo h1 b{background:linear-gradient(135deg,#FFD83A,#E7B74B); -webkit-background-clip:text; background-clip:text; color:transparent}
.kcauth-intro .skip{position:absolute; bottom:26px; left:0; right:0; text-align:center; font-size:10.5px; letter-spacing:.2em; text-transform:uppercase; color:#5f72a0; font-weight:700}
@keyframes kcIntroZoom{0%{transform:scale(3.6)}28%{transform:scale(3.6)}62%{transform:scale(1)}100%{transform:scale(1)}}
@keyframes kcHandshake{from{transform:translateY(-5px)}to{transform:translateY(5px)}}
@keyframes kcFigsFade{to{opacity:0}}
@keyframes kcLogoReveal{0%{opacity:0; transform:scale(.7)}100%{opacity:1; transform:scale(1)}}
@keyframes kcIntroOut{to{opacity:0; visibility:hidden}}
@media(prefers-reduced-motion:reduce){ .kcauth-intro{display:none} }
`;

function I({ d, c }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{c || <path d={d} />}</svg>; }
const MailIc = <I c={<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>} />;
const LockIc = <I c={<><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>} />;
const UserIc = <I c={<><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>} />;
const EyeIc = <I c={<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>} />;
const EyeOffIc = <I c={<><path d="M3 3l18 18" /><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" /><path d="M9.9 5.2A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.8 17.8 0 0 1-3.3 4.1M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7 10 7a10.3 10.3 0 0 0 3.4-.6" /></>} />;
const CheckIc = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path d="M5 13l4 4L19 7" /></svg>;

// The login intro clip is shot on a green screen, and CSS has no chroma key — `mix-blend-mode`
// can only drop black. So we key the green out ourselves to get real per-pixel alpha.
//
// This runs on the GPU. The obvious implementation (canvas 2D + getImageData + a per-pixel JS
// loop + putImageData) stalls the main thread every frame: getImageData forces a synchronous
// pixel readback, and the readback plus the loop is long enough to drop frames and visibly
// judder the CSS zoom animating alongside it. A fragment shader does the same work per pixel
// in parallel with no readback at all, so the main thread stays free for the animation.
//
// Frames are pushed by requestVideoFrameCallback where it exists, which fires exactly once per
// decoded video frame — so we upload one texture per real frame instead of re-keying the same
// frame 60x a second. rAF is the fallback. Canvas 2D remains as a last resort for no-WebGL.
const CHROMA_VS = `attribute vec2 p; varying vec2 uv;
void main(){ uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;
// `lo`/`hi` ramp the alpha instead of hard-cutting it, which antialiases the edge of the hands
// rather than leaving the stair-stepped border a boolean test gives you.
const CHROMA_FS = `precision mediump float; uniform sampler2D t; varying vec2 uv;
void main(){
  vec4 c = texture2D(t, uv);
  float rest = (c.r + c.b) * .5;
  float green = c.g - rest;                      // how far into green this pixel leans
  float a = 1. - smoothstep(.04, .16, green);    // soft edge, not a hard threshold
  if (c.g < .20) a = 1.;                         // dark shadows are never the backdrop
  c.g = min(c.g, rest + .02);                    // suppress green spill on skin and cuffs
  gl_FragColor = vec4(c.rgb, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

function ChromaVideo({ src, onFail }) {
  const vRef = useRef(null);
  const cRef = useRef(null);
  useEffect(() => {
    const v = vRef.current, c = cRef.current;
    if (!v || !c) return;
    let stopped = false, rafId = 0, vfcId = 0;
    let gl = null, tex = null, ctx2d = null;

    // GPU path. premultipliedAlpha:false keeps the shader's straight alpha from darkening the
    // edge pixels when the compositor blends the canvas over the page.
    function initGL() {
      try {
        gl = c.getContext("webgl", { premultipliedAlpha: false, antialias: false, depth: false, stencil: false })
          || c.getContext("experimental-webgl", { premultipliedAlpha: false });
      } catch (e) { gl = null; }
      if (!gl) return false;
      const vs = compile(gl, gl.VERTEX_SHADER, CHROMA_VS);
      const fs = compile(gl, gl.FRAGMENT_SHADER, CHROMA_FS);
      if (!vs || !fs) return false;
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // CLAMP + LINEAR so the non-power-of-two 640x360 frame is a legal texture in WebGL 1.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.clearColor(0, 0, 0, 0);
      return true;
    }

    // CPU fallback, only reached when WebGL is unavailable.
    function initCPU() {
      try { ctx2d = c.getContext("2d", { willReadFrequently: true }); } catch (e) { ctx2d = null; }
      return !!ctx2d;
    }

    function paint() {
      if (v.readyState < 2 || !c.width) return;
      if (gl) {
        gl.viewport(0, 0, c.width, c.height);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); } catch (e) { return; }
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return;
      }
      ctx2d.drawImage(v, 0, 0, c.width, c.height);
      let frame;
      try { frame = ctx2d.getImageData(0, 0, c.width, c.height); } catch (e) { return; }
      const d = frame.data;
      for (let i = 0; i < d.length; i += 4) {
        const rest = (d[i] + d[i + 2]) / 2;
        if (d[i + 1] > 70 && d[i + 1] > rest * 1.35) d[i + 3] = 0;
        else if (d[i + 1] > rest * 1.06) d[i + 1] = rest;
      }
      ctx2d.putImageData(frame, 0, 0);
    }

    function tick() {
      if (stopped) return;
      paint();
      schedule();
    }
    function schedule() {
      if (stopped) return;
      if (v.requestVideoFrameCallback) vfcId = v.requestVideoFrameCallback(tick);
      else rafId = requestAnimationFrame(tick);
    }

    function start() {
      c.width = v.videoWidth || 640;
      c.height = v.videoHeight || 360;
      if (!initGL() && !initCPU()) { onFail && onFail(); return; }
      schedule();
    }

    v.addEventListener("loadeddata", start);
    const p = v.play();
    if (p && p.catch) p.catch(() => {}); // autoplay rejection is harmless; the frame loop still runs
    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      if (vfcId && v.cancelVideoFrameCallback) { try { v.cancelVideoFrameCallback(vfcId); } catch (e) {} }
      v.removeEventListener("loadeddata", start);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <video ref={vRef} src={src} muted playsInline preload="auto" onError={onFail} style={{ display: "none" }} />
      <canvas ref={cRef} className="vid" />
    </>
  );
}

// Decorative background: particles + a faint intelligence-network.
function Backdrop() {
  const dots = [[12, 18], [86, 12, "g"], [22, 78], [70, 84, "g"], [50, 8], [92, 60], [6, 50], [40, 92], [78, 38]];
  return (
    <>
      <svg className="net" viewBox="0 0 100 100" preserveAspectRatio="none">
        <g stroke="rgba(124,92,255,.22)" strokeWidth=".15" fill="none">
          <path d="M12 18 L50 8 L86 12 M50 8 L40 40 L22 78 M40 40 L70 50 L92 60 M70 50 L78 84 M40 40 L6 50" />
        </g>
        <g fill="rgba(124,92,255,.5)">
          {[[12, 18], [50, 8], [86, 12], [40, 40], [22, 78], [70, 50], [92, 60], [78, 84], [6, 50]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r=".5" />)}
        </g>
      </svg>
      {dots.map(([l, t, g], i) => <span key={i} className={"pdot" + (g ? " g" : "")} style={{ left: l + "%", top: t + "%", animationDelay: (i * 0.7) + "s" }} />)}
    </>
  );
}

// Front door. Open sign-up: anyone can create an account. Data stays per-account
// (server-side, scoped by user_id) when a database is configured, or per-browser otherwise.
export function AuthGate({ children }) {
  const [localEmail, setLocalEmail] = useState(() => { try { return localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; } });
  // authMode: undefined (probing) | "remote" (DB-backed accounts) | "local" (per-browser fallback)
  const [authMode, setAuthMode] = useState(undefined);
  const [session, setSession] = useState(() => currentUser()); // the signed-in user object, or null
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [adminCode, setAdminCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showResend, setShowResend] = useState(false);
  const [resetToken, setResetToken] = useState(""); // set from a ?reset=<token> email link
  // Cinematic handshake intro — plays whenever the login screen loads; click to skip.
  const [intro, setIntro] = useState(true);
  // Use /login-intro.mp4 if present; otherwise fall back to the silhouette animation.
  const [videoOk, setVideoOk] = useState(true);
  function endIntro() { setIntro(false); }
  useEffect(() => {
    if (!intro) return;
    let reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    if (reduce) { endIntro(); return; }
    const t = setTimeout(endIntro, 4400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After the email-confirmation link redirects back with ?verified=1 / ?verified=0,
  // or after an inactivity auto-logout redirects with ?timeout=1.
  useEffect(() => {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    const v = params.get("verified");
    if (v === "1") setNotice("Email confirmed. You can sign in now.");
    else if (v === "0") { setErr("That confirmation link is invalid or has expired. Sign in to get a new one."); setShowResend(true); }
    if (params.get("timeout") === "1") setNotice("You were signed out after 30 minutes of inactivity. Please sign in again.");
    if (v != null || params.get("timeout") != null) {
      try { window.history.replaceState({}, "", window.location.pathname); } catch (e) {}
    }
  }, []);

  // After a password-reset email link redirects back with ?reset=<token>, show the set-new-password form.
  useEffect(() => {
    let t;
    try { t = new URLSearchParams(window.location.search).get("reset"); } catch (e) { return; }
    if (!t) return;
    setResetToken(t);
    try { window.history.replaceState({}, "", window.location.pathname); } catch (e) {}
  }, []);

  useEffect(() => {
    let active = true;
    const unsub = onAuthChange((u) => { if (active) setSession(u); });
    authAvailable().then(async (ok) => {
      if (!active) return;
      /* With the local sign-in bypass on, the server answers every request as
         the configured developer, so a login screen here would ask for a
         password nothing checks. Treat it as signed in. */
      setAuthMode(ok || authAvailable.devAuth ? "remote" : "local");
      if (ok) { await refreshUser(); if (active) setSession(currentUser()); }
    });
    return () => { active = false; unsub(); };
  }, []);

  const remote = authMode === "remote";
  const sessionEmail = session?.email;
  function grant(userEmail, onSignOut) {
    /* Someone sent here from elsewhere on the site — Karma Leads redirects to
       this page when it finds no session — goes back where they came from
       rather than landing on Connect's dashboard.

       Only a same-site path is honoured: never "//elsewhere.com" and never a
       full URL, so ?next= cannot be used to bounce anyone off the site. */
    try {
      const next = new URLSearchParams(window.location.search).get("next");
      if (next && next.startsWith("/") && !next.startsWith("//")) {
        window.location.replace(next);
        return null;
      }
    } catch (e) { /* no query to read — just render */ }
    return cloneElement(children, { key: userEmail || "anon", userEmail: userEmail || "", onSignOut });
  }
  if (remote) {
    if (session) return grant(sessionEmail, () => signOut());
  } else if (authMode === "local" && localEmail) {
    return grant(localEmail, () => { try { localStorage.removeItem(LS_KEY); } catch (e) {} setLocalEmail(""); });
  }

  const typedAddr = email.trim().toLowerCase();
  const softCreating = !remote && EMAIL_RE.test(typedAddr) && !hasPassword(typedAddr);
  const creating = remote ? mode === "signup" : softCreating;

  async function handleSubmit(e) {
    e.preventDefault();
    setErr(""); setNotice("");
    const addr = email.trim().toLowerCase();
    if (!addr) { setErr("Enter your email."); return; }
    if (!EMAIL_RE.test(addr)) { setErr("Enter a valid email address."); return; }

    if (!remote) {
      setBusy(true);
      try {
        if (!hasPassword(addr)) {
          if (!password || password.length < 6) { setErr("Choose a password of at least 6 characters."); setBusy(false); return; }
          if (password !== password2) { setErr("The two passwords don't match."); setBusy(false); return; }
          await setLocalPw(addr, password);
        } else {
          if (!(await verifyPassword(addr, password))) { setErr("Wrong password."); setBusy(false); return; }
        }
        try { localStorage.setItem(LS_KEY, addr); } catch (e2) {}
        setLocalEmail(addr);
      } catch (e4) { setErr("Could not process the password. Try again."); }
      setBusy(false);
      return;
    }

    if (!password || password.length < 8) { setErr("Use a password of at least 8 characters."); return; }
    if (mode === "signup" && password !== password2) { setErr("The two passwords don't match."); return; }
    setBusy(true);
    try {
      if (mode === "signup") {
        const r = await signUp({ email: addr, password, firstName: firstName.trim(), lastName: lastName.trim(), adminCode: adminCode.trim() });
        if (r && r.needsVerification) {
          // Email confirmation required — don't log in; prompt them to check their inbox.
          setNotice(r.message || "Account created. Check your email for a confirmation link, then sign in.");
          setMode("signin"); setPassword(""); setPassword2(""); setShowResend(true);
        } else if (r && r.warning) {
          /* Signed in, but something the operator should know about happened on
             the way — email delivery failing, most likely. Say so rather than
             letting it pass silently: the person who just signed up is the one
             who can report it. */
          setErr(r.warning);
        }
        // else: verification off → signUp logged us in; onAuthChange flips the gate.
      } else {
        await signIn({ email: addr, password });
        // onAuthChange updates `session`, which flips the gate to the app.
      }
    } catch (e3) {
      const msg = (e3 && e3.message) || "Could not sign in. Check your details and try again.";
      setErr(msg);
      if (/confirm your email/i.test(msg)) setShowResend(true);
    }
    setBusy(false);
  }

  async function resend() {
    setErr(""); setNotice("");
    const addr = email.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) { setErr("Enter your email first, then tap Resend."); return; }
    setBusy(true);
    try {
      const r = await resendVerification(addr);
      setNotice((r && r.message) || "If that account exists and is unconfirmed, a new confirmation email is on its way.");
    } catch (e) { setErr("Could not resend right now. Try again in a moment."); }
    setBusy(false);
  }

  async function forgot() {
    setErr(""); setNotice("");
    const addr = email.trim().toLowerCase();
    if (!remote) {
      if (!EMAIL_RE.test(addr)) { setErr("Enter your email first."); return; }
      if (!window.confirm("Reset the password for " + addr + "? You'll set a new one.")) return;
      clearPassword(addr); setPassword(""); setPassword2(""); setNotice("Password cleared. Set a new one below.");
      return;
    }
    if (!EMAIL_RE.test(addr)) { setErr("Enter your email first, then tap Forgot password."); return; }
    setBusy(true);
    try {
      const r = await requestPasswordReset(addr);
      setNotice((r && r.message) || "If an account exists for that email, a password reset link is on its way.");
    } catch (e) {
      setErr((e && e.message) || "Could not start a reset right now. Try again in a moment.");
    }
    setBusy(false);
  }

  // Submit the set-new-password form (reached via the emailed ?reset link).
  async function handleReset(e) {
    e.preventDefault();
    setErr(""); setNotice("");
    if (!password || password.length < 8) { setErr("Use a password of at least 8 characters."); return; }
    if (password !== password2) { setErr("The two passwords don't match."); return; }
    setBusy(true);
    try {
      await resetPassword(resetToken, password);
      // resetPassword logs us in (onAuthChange flips the gate); clear the token to be safe.
      setResetToken("");
    } catch (e2) {
      setErr((e2 && e2.message) || "Could not reset the password. The link may have expired — request a new one.");
    }
    setBusy(false);
  }

  if (authMode === undefined) {
    return <div className="kcauth"><style>{AUTH_CSS}</style><p style={{ color: "#9aa7c4" }}>Loading…</p></div>;
  }

  // Set-new-password screen, reached from the emailed reset link (?reset=<token>).
  if (remote && resetToken) {
    return (
      <div className="kcauth">
        <style>{AUTH_CSS}</style>
        <Backdrop />
        <div className="center">
          <div className="brand">
            <div className="mk"><KarmaIcon w={62} /></div>
            <h1>Karma <b>Connect</b></h1>
            <p>AI-Powered Prospect Intelligence</p>
          </div>
          <div className="card">
            <h2>Set a new password</h2>
            <div className="sub">Choose a new password for your account. You'll be signed in right after.</div>
            <form onSubmit={handleReset}>
              <label>New password</label>
              <div className="field">
                <span className="ic">{LockIc}</span>
                <input type={showPw ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
                <button type="button" className="eye" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? "Hide password" : "Show password"}>{showPw ? EyeOffIc : EyeIc}</button>
              </div>
              <label>Confirm new password</label>
              <div className="field"><span className="ic">{LockIc}</span><input type={showPw ? "text" : "password"} autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} placeholder="Re-enter your new password" /></div>
              <button className="cta" type="submit" disabled={busy}>{busy ? "Working…" : "Reset password"}</button>
              {err && <p className="msg err">{err}</p>}
              {notice && <p className="msg ok">{notice}</p>}
            </form>
            <div className="foot">
              <button type="button" className="lk" onClick={() => { setResetToken(""); setPassword(""); setPassword2(""); setErr(""); setNotice(""); }}>Back to sign in</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="kcauth">
      <style>{AUTH_CSS}</style>
      <Backdrop />
      {intro && (
        <div className="kcauth-intro" onClick={endIntro} title="Click to skip">
          <div className="stage">
            {videoOk ? (
            <ChromaVideo src="/login-intro.mp4" onFail={() => setVideoOk(false)} />
            ) : (
            <svg viewBox="0 0 400 300" fill="none" stroke="#e7eefb" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
              <g className="figs">
                {/* left silhouette (facing right) */}
                <circle cx="118" cy="72" r="21" fill="#e7eefb" stroke="none" />
                <path d="M118 94 L118 184" />
                <path d="M118 184 L98 248" />
                <path d="M118 184 L138 248" />
                <path d="M118 120 L94 158" />
                {/* right silhouette (facing left) */}
                <circle cx="282" cy="72" r="21" fill="#e7eefb" stroke="none" />
                <path d="M282 94 L282 184" />
                <path d="M282 184 L302 248" />
                <path d="M282 184 L262 248" />
                <path d="M282 120 L306 158" />
                {/* clasped hands — the focal point, shakes */}
                <g className="hands">
                  <path d="M118 120 L190 162" />
                  <path d="M282 120 L210 162" />
                  <path d="M185 162 L215 162" stroke="#FFCF00" strokeWidth="22" />
                </g>
              </g>
            </svg>
            )}
            <div className="logo">
              <div className="mk"><KarmaIcon w={88} /></div>
              <h1>Karma <b>Connect</b></h1>
            </div>
          </div>
          <div className="skip">click to skip</div>
        </div>
      )}
      <div className="center">
        <div className="brand">
          <div className="mk"><KarmaIcon w={62} /></div>
          <h1>Karma <b>Connect</b></h1>
          <p>AI-Powered Prospect Intelligence</p>
        </div>

        <div className="card">
          <h2>{creating ? "Create Your Account" : "Welcome Back"}</h2>
          <div className="sub">{creating ? "Set up your workspace access to Karma Connect." : "Sign in to continue your prospecting journey."}</div>

          <form onSubmit={handleSubmit}>
            {remote && mode === "signup" && (
              <div className="row2">
                <div><label>First name</label><div className="field"><span className="ic">{UserIc}</span><input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jane" /></div></div>
                <div><label>Last name</label><div className="field"><span className="ic">{UserIc}</span><input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" /></div></div>
              </div>
            )}

            <label>{creating ? "Work email" : "Email address"}</label>
            <div className="field"><span className="ic">{MailIc}</span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></div>

            <label>Password</label>
            <div className="field">
              <span className="ic">{LockIc}</span>
              <input type={showPw ? "text" : "password"} autoComplete={creating ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" />
              <button type="button" className="eye" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? "Hide password" : "Show password"}>{showPw ? EyeOffIc : EyeIc}</button>
            </div>

            {creating && (
              <>
                <label>Confirm password</label>
                <div className="field"><span className="ic">{LockIc}</span><input type={showPw ? "text" : "password"} autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} placeholder="Re-enter your password" /></div>
              </>
            )}

            {remote && mode === "signup" && (
              <>
                <label>Admin code <span style={{ color: "#6f7fa6", fontWeight: 500 }}>(optional)</span></label>
                <div className="field"><span className="ic">{LockIc}</span><input type="password" autoComplete="off" value={adminCode} onChange={(e) => setAdminCode(e.target.value)} placeholder="Leave blank — only if you were given one" /></div>
              </>
            )}

            {!creating && (
              <div className="util">
                <span className="rm" onClick={() => setRemember((v) => !v)}><span className={"box" + (remember ? " on" : "")}>{remember && CheckIc}</span>Remember me</span>
                <button type="button" className="lk" onClick={forgot}>Forgot password?</button>
              </div>
            )}

            <button className="cta" type="submit" disabled={busy}>
              {busy ? "Working…" : creating ? "Create Account" : "Sign In"}
            </button>
            {err && <p className="msg err">{err}</p>}
            {notice && <p className="msg ok">{notice}</p>}
            {showResend && remote && (
              <p className="msg" style={{ marginTop: 10, color: "#9aa7c4" }}>
                Didn't get the email? <button type="button" className="lk" onClick={resend} disabled={busy}>Resend confirmation</button>
              </p>
            )}
          </form>

          {remote && (
            <div className="foot">
              {mode === "signup" ? "Already have an account? " : "New here? "}
              <button type="button" className="lk" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setErr(""); setNotice(""); }}>
                {mode === "signup" ? "Sign in" : "Create an account"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
