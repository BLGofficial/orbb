"use strict";
(() => {
  // src/orb/orbState.ts
  var ORB_STATES = ["idle", "listening", "thinking", "speaking", "analysing", "rendering"];
  var STATE_TARGETS = {
    idle: { energy: 0.45, spin: 0.12, turbulence: 0.3, flow: 0.15, reactivity: 0.15, scan: 0, arc: 0 },
    listening: { energy: 0.6, spin: 0.18, turbulence: 0.35, flow: -0.8, reactivity: 0.9, scan: 0, arc: 0 },
    thinking: { energy: 0.7, spin: 0.55, turbulence: 0.75, flow: 0.05, reactivity: 0.1, scan: 0, arc: 0 },
    speaking: { energy: 0.75, spin: 0.22, turbulence: 0.45, flow: 0.9, reactivity: 1, scan: 0, arc: 0 },
    analysing: { energy: 0.65, spin: 0.3, turbulence: 0.4, flow: 0.2, reactivity: 0, scan: 1, arc: 0 },
    rendering: { energy: 0.8, spin: 0.4, turbulence: 0.5, flow: 0.6, reactivity: 0, scan: 0, arc: 1 }
  };
  var clamp01 = (x) => Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
  var smooth = (current, target, dt, tau) => (
    // lerp form: exact at dt=0 (the target-offset form drifts by 1 ulp)
    current + (target - current) * (1 - Math.exp(-dt / tau))
  );
  var smoothParams = (cur, tgt, dt, tau) => ({
    energy: smooth(cur.energy, tgt.energy, dt, tau),
    spin: smooth(cur.spin, tgt.spin, dt, tau),
    turbulence: smooth(cur.turbulence, tgt.turbulence, dt, tau),
    flow: smooth(cur.flow, tgt.flow, dt, tau),
    reactivity: smooth(cur.reactivity, tgt.reactivity, dt, tau),
    scan: smooth(cur.scan, tgt.scan, dt, tau),
    arc: smooth(cur.arc, tgt.arc, dt, tau)
  });
  var envelope = (prev, input, dt, attack = 0.025, release = 0.22) => {
    const x = clamp01(input);
    return smooth(prev, x, dt, x > prev ? attack : release);
  };
  var clampDt = (dt) => Math.min(0.1, Math.max(0, dt));
  var QUALITY_SCALES = [1, 0.85, 0.7, 0.55];
  var SLOW_MS = 22;
  var FAST_MS = 18;
  var SLOW_SPAN_MS = 500;
  var SLOW_MIN_FRAMES = 8;
  var FAST_FRAMES = 240;
  var MAX_BACKOFF = 16;
  var initialQuality = () => ({
    step: 0,
    scale: QUALITY_SCALES[0],
    slow: 0,
    slowMs: 0,
    fast: 0,
    drops: 0
  });
  var nextQuality = (q, frameMs) => {
    const isSlow = frameMs > SLOW_MS;
    const slow = isSlow ? q.slow + 1 : 0;
    const slowMs = isSlow ? q.slowMs + frameMs : 0;
    const fast = frameMs < FAST_MS ? q.fast + 1 : 0;
    const last = QUALITY_SCALES.length - 1;
    if (slow >= SLOW_MIN_FRAMES && slowMs >= SLOW_SPAN_MS && q.step < last) {
      const step = q.step + 1;
      return { step, scale: QUALITY_SCALES[step], slow: 0, slowMs: 0, fast: 0, drops: q.drops + 1 };
    }
    const needed = FAST_FRAMES * Math.min(MAX_BACKOFF, 2 ** Math.max(0, q.drops - 1));
    if (fast >= needed && q.step > 0) {
      const step = q.step - 1;
      return { step, scale: QUALITY_SCALES[step], slow: 0, slowMs: 0, fast: 0, drops: q.drops };
    }
    return { ...q, slow, slowMs, fast };
  };

  // src/orb/shaders.ts
  var HEADER = (
    /* glsl */
    `#version 300 es
precision highp float;
`
  );
  var NOISE = (
    /* glsl */
    `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p){ float s = 0., a = .5; for (int i = 0; i < 3; i++){ s += a * vnoise(p); p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= .5; } return s / .875; }
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c,0,-s, 0,1,0, s,0,c); }
mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1,0,0, 0,c,s, 0,-s,c); }
// Per-channel exponential saturation: dim light reads deep amber, stacked light burns to white-hot. Acts as tonemap.
vec3 goldTone(float L){ return 1. - exp(-L * vec3(1.0, 0.64, 0.26) * 1.7); }
// 1 inside, 0 at the canvas border: small embeds fade out instead of clipping against their box.
float edgeFade(vec2 fc, vec2 res){ vec2 m = min(fc, res - fc); return smoothstep(0., .1 * min(res.x, res.y), min(m.x, m.y)); }
`
  );
  var FULLSCREEN_VS = (
    /* glsl */
    `${HEADER}
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`
  );
  var BACKGROUND_FS = (
    /* glsl */
    `${HEADER}
uniform vec2 uRes; uniform float uR, uPx, uTime, uFlowPhase, uEnergy, uTransparent;
out vec4 o;
${NOISE}
void main(){
  vec2 p = gl_FragCoord.xy - .5 * uRes;
  float r = length(p) / uR;
  float ang = atan(p.y, p.x);
  const float N = 140.;
  // warp sampled on the unit circle so it is periodic: no seam where atan wraps
  float warp = (vnoise(vec3(cos(ang) * 2.2, sin(ang) * 2.2, r * .9 + uTime * .035)) - .5) * 9.;   // bends lines into hairs
  float v = (ang / 6.2831853 + .5) * N + warp;
  float id = floor(v + .5);
  float dpx = abs(v - id) * 6.2831853 * r * uR / N;          // distance to line, in buffer px
  float line = 1. - smoothstep(.2 * uPx, .9 * uPx, dpx);
  float rnd = hash12(vec2(mod(id, N), 3.1));
  float seg = fract(r * (.5 + .6 * rnd) - uFlowPhase * (.4 + .6 * rnd) + rnd * 13.);
  float dash = smoothstep(0., .25, seg) * smoothstep(.6, .3, seg);
  float fall = smoothstep(1.0, 1.2, r) * exp(-(r - 1.) * 1.1);
  float L = .42 * line * dash * step(.66, rnd) * fall * (.3 + .7 * uEnergy);
  vec3 col = goldTone(L * edgeFade(gl_FragCoord.xy, uRes));
  float vig = 1. - smoothstep(.15, .95, length(p) / max(uRes.x, uRes.y));
  col += vec3(.022, .017, .012) * vig * (1. - uTransparent);
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 61.) - .5) / 255.;   // dither: kills banding in the dark gradient
  o = vec4(max(col, 0.), uTransparent > .5 ? max(col.r, max(col.g, col.b)) : 1.);
}`
  );
  var ORB_VS = (
    /* glsl */
    `${HEADER}
uniform vec2 uRes; uniform float uHalf;
void main(){
  vec2 c = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 2. - 1.;
  gl_Position = vec4(c * uHalf / (uRes * .5), 0., 1.);
}`
  );
  var ORB_FS = (
    /* glsl */
    `${HEADER}
uniform vec2 uRes;
uniform float uR, uPx, uTime, uRot, uEnergy, uTurb, uLevel, uScan, uScanPhase, uArc, uProgress;
out vec4 o;
${NOISE}
// Contour lines of warped fbm at constant on-screen width (fwidth), which reads as thin energy filaments.
float filaments(vec3 q, float count, out float glow){
  float v = fbm3(q) * count;
  float d = abs(fract(v + .5) - .5);
  float fw = max(fwidth(v), 1e-4);
  glow = exp(-d / (fw * 5.));
  return 1. - smoothstep(.25 * fw, 1.25 * fw, d);
}
void main(){
  vec2 p = gl_FragCoord.xy - .5 * uRes;
  float R = uR;
  float r = length(p) / R;
  float ang = atan(p.y, p.x);
  float t = uTime;
  float L = 0.;

  // ---- sphere body (no branching: fwidth needs uniform control flow)
  float rc = min(r, .9995);
  float z = sqrt(1. - rc * rc);
  float inside = 1. - smoothstep(1. - 1.5 * uPx / R, 1., r);
  vec3 nF = vec3(p / R, z), nB = vec3(p / R, -z);
  mat3 M = rotY(uRot) * rotX(.45 + .08 * sin(t * .13));
  vec3 qF = M * nF, qB = M * nB;
  vec3 w = vec3(vnoise(qF * 1.6 + t * .07), vnoise(qF * 1.6 + 4.1 - t * .05), 0.) - .5;
  float wAmt = .5 + 1.5 * uTurb;
  float gF, gB;
  vec3 str = vec3(.55, 1.6, .55);                                       // squash x/z: contours elongate into strands
  float fF = filaments(qF * str + w * wAmt + vec3(0., t * .03, 0.), 5., gF);
  float fB = filaments(qB * str + w * wAmt * .7 + 3.7, 5., gB);
  float mF = smoothstep(.2, .6, vnoise(qF * 1.1 + t * .05));            // fade parts of the web in/out
  float mB = smoothstep(.25, .7, vnoise(qB * 1.1 - t * .04 + 9.));
  float fres = pow(1. - z, 2.2);
  float drive = .55 + .6 * uEnergy + .9 * uLevel;
  L += inside * mF * (fF * 1.9 + gF * .45) * (.5 + 1.1 * fres) * drive;
  L += inside * mB * (fB * .55 + gB * .08) * drive * .6;               // back hemisphere through the glass
  L += inside * .07 * (.5 + uEnergy) * (1. - rc * rc);                 // volumetric haze
  L += inside * .9 * pow(fres, 2.) * (.4 + .6 * uEnergy);              // fresnel shell

  // ---- analysing: horizontal scan band sweeping the sphere
  float sy = sin(uScanPhase) * .82;
  float dy = nF.y - sy;
  L += uScan * inside * (exp(-dy * dy / .0006) * 1.4 + exp(-dy * dy / .02) * fF * 2.2);

  // ---- rim: thin hot line with an organic wobble, plus bloom-like falloff both sides
  float wob = (vnoise(vec3(cos(ang) * 2.5, sin(ang) * 2.5, t * .35)) - .5) * .014 * (1. + uTurb);
  float dr = r - 1. - wob;
  float rimW = 1.4 * uPx / R;
  L += exp(-dr * dr / (rimW * rimW)) * (1.1 + 1.3 * uEnergy + 2.2 * uLevel);
  L += exp(-abs(dr) * 10.) * (.22 + .45 * uEnergy + .7 * uLevel);
  L += step(0., dr) * exp(-dr * 3.2) * .1 * (.5 + uEnergy + uLevel);

  // ---- rendering: progress arc, clockwise from 12 o'clock
  float ra = 1.13;
  float dpx = abs(r - ra) * R;
  float ring = 1. - smoothstep(.9 * uPx, 2. * uPx, dpx);
  float a01 = fract(.25 - ang / 6.2831853);
  L += uArc * ring * (.16 + 2.4 * step(a01, uProgress));
  vec2 head = vec2(sin(uProgress * 6.2831853), cos(uProgress * 6.2831853)) * ra * R;
  float hd = length(p - head) / uPx;
  L += uArc * exp(-hd * hd / 30.) * 3.;

  L *= (1. - smoothstep(1.22, 1.42, r)) * edgeFade(gl_FragCoord.xy, uRes);                                // reach zero inside the quad: no square seam
  vec3 col = goldTone(L);
  o = vec4(col, max(col.r, max(col.g, col.b)));                        // additive pass; alpha only matters when transparent
}`
  );
  var PARTICLE_VS = (
    /* glsl */
    `${HEADER}
uniform vec2 uRes;
uniform float uR, uPx, uTime, uRot, uFlowPhase, uEnergy, uLevel;
out vec3 vCol; out float vA;
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c,0,-s, 0,1,0, s,0,c); }
mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1,0,0, 0,c,s, 0,-s,c); }
vec4 hash41(float p){ vec4 p4 = fract(vec4(p) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
vec3 sphereDir(vec2 h){ float u = h.x * 2. - 1., th = h.y * 6.2831853, s = sqrt(1. - u * u); return vec3(s * cos(th), u, s * sin(th)); }
void main(){
  float id = float(gl_VertexID);
  vec4 h = hash41(id + .5), h2 = hash41(id * 1.37 + 11.);
  vec3 gold = vec3(1., .72, .32);
  vec2 pos; float size, a; vec3 col = gold;
  if (h.w < .52) {                                   // shell speckle, rides the sphere surface
    vec3 n = rotY(uRot * (.85 + .3 * h2.x)) * rotX(.45) * sphereDir(h.xy);
    pos = n.xy * (1. + (h.z - .5) * .05 + .035 * uLevel * h2.y);
    a = mix(.14, .85, smoothstep(-.2, .3, n.z)) * (.45 + .55 * uEnergy);
    size = mix(.8, 2.3, pow(h2.z, 3.));
  } else if (h.w < .82) {                            // halo: flows out (speaking) or in (listening) via uFlowPhase sign
    float life = fract(h.y + uFlowPhase * (.5 + h.z));
    float ang = h.x * 6.2831853 + .18 * sin(life * 3. + h2.y * 6.);
    pos = vec2(cos(ang), sin(ang)) * mix(1., 1.9 + h2.x * .8, life);
    a = sin(life * 3.14159) * (.22 + .5 * uEnergy + .4 * uLevel) * (.4 + .6 * h2.z);
    size = mix(.8, 1.8, h2.w);
  } else if (h.w < .996) {                           // inner dust, twinkling
    vec3 n = rotY(uRot * .5) * sphereDir(h.xy) * pow(h.z, 1. / 3.) * .92;
    pos = n.xy;
    a = (.12 + .88 * pow(.5 + .5 * sin(uTime * (.8 + h2.x * 2.5) + h2.y * 40.), 6.)) * (.35 + .65 * uEnergy);
    size = mix(.8, 2., h2.z);
  } else {                                           // rare blue sparks (as in the reference)
    vec3 n = rotY(uRot * 1.1) * sphereDir(h.xy) * (.6 + .35 * h.z);
    pos = n.xy;
    col = vec3(.35, .62, 1.);
    a = (.5 + .5 * sin(uTime * 2. + h2.x * 20.)) * smoothstep(-.3, .2, n.z);
    size = 2.6;
  }
  vec2 px = pos * uR;
  vec2 m = uRes * .5 - abs(px);
  a *= smoothstep(0., .1 * min(uRes.x, uRes.y), min(m.x, m.y));      // fade before the canvas border
  gl_Position = vec4(px / (uRes * .5), 0., 1.);
  gl_PointSize = max(2., size * uPx * 2.6);          // sprite larger than the core so the gaussian tail fits
  vCol = col; vA = a;
}`
  );
  var PARTICLE_FS = (
    /* glsl */
    `${HEADER}
in vec3 vCol; in float vA;
out vec4 o;
void main(){
  vec2 c = gl_PointCoord * 2. - 1.;
  float d2 = dot(c, c);
  float k = vA * (exp(-d2 * 5.) * .55 + exp(-d2 * 22.) * .9);
  vec3 col = (vCol + vec3(.4, .35, .3) * exp(-d2 * 22.)) * k;        // white-hot core
  o = vec4(col, k);
}`
  );
  var LOGO_VS = (
    /* glsl */
    `${HEADER}
uniform vec2 uRes, uHalf;
out vec2 vUv;
void main(){
  vec2 c = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  vUv = vec2(c.x, 1. - c.y);                           // canvas row 0 is the top
  gl_Position = vec4((c * 2. - 1.) * uHalf / (uRes * .5), 0., 1.);
}`
  );
  var LOGO_FS = (
    /* glsl */
    `${HEADER}
uniform sampler2D uTex;
uniform vec2 uPad;
uniform float uTime, uEnergy, uLevel;
in vec2 vUv;
out vec4 o;
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
// Official symbol gradient (XYP3RN_Official_Symbol.svg): 0 #FFF3B3, .19 #FFD95D, .52 #E7A51B, .78 #C77B08, 1 #F6CA48
vec3 officialGold(float x){
  vec3 c0 = vec3(1., .953, .702), c1 = vec3(1., .851, .365), c2 = vec3(.906, .647, .106), c3 = vec3(.78, .482, .031), c4 = vec3(.965, .792, .282);
  return x < .19 ? mix(c0, c1, x / .19) : x < .52 ? mix(c1, c2, (x - .19) / .33) : x < .78 ? mix(c2, c3, (x - .52) / .26) : mix(c3, c4, (x - .78) / .22);
}
void main(){
  float a = texture(uTex, vUv).r;
  // bevel normal from a blurred height field; offsets in screen px so the bevel width is resolution independent
  vec2 e = fwidth(vUv) * 2.5;
  float hx = texture(uTex, vUv + vec2(e.x, 0.), 1.5).r - texture(uTex, vUv - vec2(e.x, 0.), 1.5).r;
  float hy = texture(uTex, vUv - vec2(0., e.y), 1.5).r - texture(uTex, vUv + vec2(0., e.y), 1.5).r;
  vec3 n = normalize(vec3(-hx, -hy, .35));
  vec3 l = normalize(vec3(-.45, .6, .66));
  float diff = clamp(dot(n, l), 0., 1.);
  float spec = pow(clamp(reflect(-l, n).z, 0., 1.), 28.);
  float b = texture(uTex, vUv, 1.).r;
  float edge = smoothstep(.2, .5, b) * smoothstep(.97, .65, b);       // bright bevel lines on every edge, as in the reference
  vec2 lu = (vUv - uPad) / (1. - 2. * uPad);                           // 0..1 over the symbol's own bbox
  vec2 gd = vec2(.82, 1.);
  vec3 base = officialGold(clamp(dot(lu, gd) / dot(gd, gd), 0., 1.));
  float brushed = .9 + .1 * hash11(floor(lu.y * 520.)) + .05 * (hash11(floor(lu.y * 1300.) + floor(lu.x * 9.)) - .5);
  float sw = fract(uTime * .11) * 3.4 - 1.;
  float sweep = exp(-pow((lu.x * .8 + lu.y * .6 - sw) / .06, 2.));      // periodic sheen pass
  float lift = .82 + .3 * uEnergy + .3 * uLevel;
  vec3 col = (base * brushed * (.5 + .65 * diff) + vec3(1., .93, .78) * (spec * .55 + edge * .5 + sweep * .45)) * lift;
  float glow = texture(uTex, vUv, 6.).r * 1.4;                         // deep mip = wide soft glow without a blur pass
  vec2 m = min(vUv, 1. - vUv);
  float win = smoothstep(0., .14, min(m.x, m.y));                     // deep mips bleed to the quad edge; fade before it
  vec3 halo = vec3(1., .6, .18) * glow * win * (.3 + .35 * uEnergy + .6 * uLevel) * (1. - a);
  o = vec4(col * a + halo, a);                                        // premultiplied; halo is additive (alpha 0)
}`
  );

  // src/orb/renderer.ts
  var compile = (gl, vs, fs, names) => {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost())
        throw new Error(`orb shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    const v = sh(gl.VERTEX_SHADER, vs);
    const f = sh(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
      throw new Error(`orb link: ${gl.getProgramInfoLog(p)}`);
    gl.deleteShader(v);
    gl.deleteShader(f);
    return { p, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)])) };
  };
  var TEX = 1024;
  var FULL_R_CSS = 156;
  var logoTexture = (gl, logo) => {
    const c = document.createElement("canvas");
    c.width = c.height = TEX;
    const ctx = c.getContext("2d");
    const s = TEX * 0.7 / Math.max(logo.width, logo.height);
    const w = logo.width * s;
    const h = logo.height * s;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, TEX, TEX);
    ctx.translate((TEX - w) / 2, (TEX - h) / 2);
    ctx.scale(s, s);
    ctx.fillStyle = "#fff";
    ctx.fill(new Path2D(logo.d), "evenodd");
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, aspect: logo.width / logo.height, padX: (TEX - w) / 2 / TEX, padY: (TEX - h) / 2 / TEX, fill: w / TEX };
  };
  var COMMON = ["uRes", "uR", "uPx", "uTime", "uEnergy", "uLevel"];
  var createOrbRenderer = (opts) => {
    const { canvas: canvas2, logo, transparent = false, maxDpr = 2, particleCount = 9e3, radius = 0.4 } = opts;
    const gl = canvas2.getContext("webgl2", {
      alpha: transparent,
      premultipliedAlpha: true,
      antialias: false,
      // everything is analytically anti-aliased in-shader; MSAA would only cost bandwidth
      depth: false,
      stencil: false,
      powerPreference: "default"
      // background effect: don't force the discrete GPU / drain battery
    });
    if (!gl) return null;
    let res = null;
    const init = () => {
      const vao = gl.createVertexArray();
      res = {
        bg: compile(gl, FULLSCREEN_VS, BACKGROUND_FS, [...COMMON, "uFlowPhase", "uTransparent"]),
        orb: compile(gl, ORB_VS, ORB_FS, [
          ...COMMON,
          "uHalf",
          "uRot",
          "uTurb",
          "uScan",
          "uScanPhase",
          "uArc",
          "uProgress"
        ]),
        part: compile(gl, PARTICLE_VS, PARTICLE_FS, [...COMMON, "uRot", "uFlowPhase"]),
        logo: compile(gl, LOGO_VS, LOGO_FS, ["uRes", "uHalf", "uTex", "uPad", "uTime", "uEnergy", "uLevel"]),
        vao,
        logoTex: logo ? logoTexture(gl, logo) : null
      };
    };
    let target = STATE_TARGETS.idle;
    let params = { ...STATE_TARGETS.idle };
    let t = 0, rot = 0, flowPhase = 0, scanPhase = 0, env = 0, prog = 0, progTarget = 0;
    let quality = initialQuality();
    let appliedScale = -1;
    let levelFn = null;
    let running = true, isStatic = false, disposed = false, lost = false, losses2 = 0;
    let raf = 0, last = 0;
    let pxPerCss = 1;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr) * quality.scale;
      const w = Math.max(1, Math.round(canvas2.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas2.clientHeight * dpr));
      if (canvas2.width !== w || canvas2.height !== h) {
        canvas2.width = w;
        canvas2.height = h;
      }
      pxPerCss = dpr;
      appliedScale = quality.scale;
      if (isStatic) draw();
    };
    const level = () => env * params.reactivity;
    const step = (dt) => {
      params = smoothParams(params, target, dt, 0.35);
      let raw = 0;
      try {
        raw = levelFn ? levelFn() : 0;
      } catch {
        raw = 0;
      }
      env = envelope(env, raw, dt);
      const lv = level();
      t += dt;
      rot += params.spin * dt * (1 + lv * 0.6);
      flowPhase += params.flow * dt * (0.16 + lv * 0.3);
      scanPhase += dt * 0.6;
      prog = smooth(prog, progTarget, dt, 0.15);
    };
    const draw = () => {
      if (!res || lost) return;
      const { bg, orb: orb2, part, logo: lp, vao, logoTex } = res;
      const W = canvas2.width, H = canvas2.height;
      const lv = level();
      const breathe = 1 + 0.012 * Math.sin(t * 1.1) * (1 - lv);
      const R = Math.min(W, H) * radius * breathe * (1 + 0.045 * lv);
      gl.viewport(0, 0, W, H);
      gl.bindVertexArray(vao);
      gl.clearColor(0, 0, 0, transparent ? 0 : 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const common = (u) => {
        gl.uniform2f(u.uRes, W, H);
        gl.uniform1f(u.uR, R);
        gl.uniform1f(u.uPx, pxPerCss);
        gl.uniform1f(u.uTime, t);
        gl.uniform1f(u.uEnergy, params.energy);
        gl.uniform1f(u.uLevel, lv);
      };
      gl.disable(gl.BLEND);
      gl.useProgram(bg.p);
      common(bg.u);
      gl.uniform1f(bg.u.uFlowPhase, flowPhase);
      gl.uniform1f(bg.u.uTransparent, transparent ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(orb2.p);
      common(orb2.u);
      gl.uniform1f(orb2.u.uHalf, R * 1.45);
      gl.uniform1f(orb2.u.uRot, rot);
      gl.uniform1f(orb2.u.uTurb, params.turbulence);
      gl.uniform1f(orb2.u.uScan, params.scan);
      gl.uniform1f(orb2.u.uScanPhase, scanPhase);
      gl.uniform1f(orb2.u.uArc, params.arc);
      gl.uniform1f(orb2.u.uProgress, prog);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.useProgram(part.p);
      common(part.u);
      gl.uniform1f(part.u.uRot, rot);
      gl.uniform1f(part.u.uFlowPhase, flowPhase);
      const rCss = R / pxPerCss;
      const count = Math.round(Math.min(particleCount, Math.max(300, particleCount * (rCss / FULL_R_CSS) ** 2)));
      gl.drawArrays(gl.POINTS, 0, count);
      if (logoTex) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(lp.p);
        const symW = R * 0.92;
        const quadW = symW / logoTex.fill;
        gl.uniform2f(lp.u.uRes, W, H);
        gl.uniform2f(lp.u.uHalf, quadW / 2, quadW / 2);
        gl.uniform2f(lp.u.uPad, logoTex.padX, logoTex.padY);
        gl.uniform1f(lp.u.uTime, t);
        gl.uniform1f(lp.u.uEnergy, params.energy);
        gl.uniform1f(lp.u.uLevel, lv);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, logoTex.tex);
        gl.uniform1i(lp.u.uTex, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    };
    const frame = (now) => {
      raf = 0;
      if (disposed || lost || !running || isStatic) return;
      const dtMs = last ? now - last : 1e3 / 60;
      last = now;
      quality = nextQuality(quality, dtMs);
      if (quality.scale !== appliedScale) resize();
      step(clampDt(dtMs / 1e3));
      draw();
      raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && running && !isStatic && !disposed && !lost) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    const drawStatic = () => {
      params = { ...target };
      env = 0;
      prog = progTarget;
      t = 2.5;
      rot = 0.9;
      flowPhase = 0.3;
      scanPhase = Math.PI / 2 - 0.9;
      draw();
    };
    const onLost = (e) => {
      e.preventDefault();
      lost = true;
      losses2 += 1;
      cancelAnimationFrame(raf);
      raf = 0;
      if (opts.onContextLost?.(losses2) === false) disposed = true;
    };
    const onRestored = () => {
      if (disposed) return;
      lost = false;
      init();
      resize();
      if (isStatic) drawStatic();
      else kick();
    };
    canvas2.addEventListener("webglcontextlost", onLost);
    canvas2.addEventListener("webglcontextrestored", onRestored);
    init();
    resize();
    kick();
    return {
      setState: (s) => {
        target = STATE_TARGETS[s];
        if (isStatic) drawStatic();
      },
      setProgress: (p) => {
        progTarget = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
        if (isStatic) drawStatic();
      },
      setLevelSource: (fn) => {
        levelFn = fn;
      },
      setRunning: (r) => {
        running = r;
        if (r) kick();
        else {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      setStatic: (s) => {
        isStatic = s;
        if (s) {
          cancelAnimationFrame(raf);
          raf = 0;
          drawStatic();
        } else kick();
      },
      resize,
      dispose: () => {
        disposed = true;
        cancelAnimationFrame(raf);
        canvas2.removeEventListener("webglcontextlost", onLost);
        canvas2.removeEventListener("webglcontextrestored", onRestored);
        if (res && !gl.isContextLost()) {
          [res.bg, res.orb, res.part, res.logo].forEach((p) => gl.deleteProgram(p.p));
          gl.deleteVertexArray(res.vao);
          if (res.logoTex) gl.deleteTexture(res.logoTex.tex);
        }
        res = null;
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    };
  };

  // src/orb/logo.ts
  var XYP3RN_SYMBOL = {
    d: "M91 149.5L91 82L251 82L333 0L9 0L9 183.47L246.78 421.25L82 586.03L82 476.97L130 428.97L130 313L0 443L0 784L362.75 421.25L250.23 308.73L405.5 153.47L560.77 308.73L448.25 421.25L811 784L811 443L681 313L681 428.97L729 476.97L729 586.03L564.22 421.25L802 183.47L802 0L478 0L560 82L720 82L720 149.5L618.75 250.75L405.5 37.5L192.25 250.75Z",
    width: 811,
    height: 784
  };

  // .harness/demo-vanilla.ts
  var stage = document.getElementById("stage");
  var canvas = document.createElement("canvas");
  canvas.className = "orb";
  canvas.setAttribute("aria-hidden", "true");
  stage.prepend(canvas);
  var label = document.getElementById("label");
  var dock = document.getElementById("dock");
  var states = document.getElementById("states");
  var mic = document.getElementById("mic");
  var range = document.getElementById("progress");
  var state = "idle";
  var progress = 0.42;
  var micRead = () => 0;
  var micStop = () => {
  };
  var micOn = false;
  var fallback = () => {
    canvas.remove();
    const img = document.createElement("img");
    img.className = "poster";
    img.src = "/icon.svg";
    img.alt = "XYP3RN";
    stage.prepend(img);
  };
  var losses = 0;
  var orb = (() => {
    try {
      return createOrbRenderer({
        canvas,
        logo: XYP3RN_SYMBOL,
        onContextLost: () => {
          if (++losses < 3) return true;
          fallback();
          return false;
        }
      });
    } catch (e) {
      console.error(e);
      return null;
    }
  })();
  if (!orb) fallback();
  var render = () => {
    label.textContent = state.toUpperCase() + (state === "rendering" ? ` ${Math.round(progress * 100)}%` : "");
    for (const b of states.querySelectorAll("button")) {
      const on = b.dataset.state === state;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
    range.hidden = state !== "rendering";
    mic.hidden = state !== "listening" && state !== "speaking";
    orb?.setState(state);
    orb?.setProgress(progress);
  };
  for (const s of ORB_STATES) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.state = s;
    b.textContent = s.toUpperCase();
    b.onclick = () => {
      state = s;
      render();
    };
    states.append(b);
  }
  range.value = String(progress);
  range.oninput = () => {
    progress = +range.value;
    render();
  };
  mic.onclick = async () => {
    if (micOn) {
      micStop();
      micRead = () => 0;
      micOn = false;
      mic.classList.remove("live");
      mic.textContent = "ENABLE MIC FOR AUDIO REACTION";
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      micRead = () => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        return Math.min(1, Math.sqrt(Math.sqrt(s / buf.length)) * 1.6);
      };
      micStop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
      micOn = true;
      mic.classList.add("live");
      mic.textContent = "MIC LIVE // TAP TO STOP";
    } catch (e) {
      mic.textContent = e instanceof DOMException && e.name === "NotAllowedError" ? "MIC BLOCKED" : "NO MIC";
    }
  };
  if (orb) {
    orb.setLevelSource(() => micRead());
    new ResizeObserver(() => orb.resize()).observe(canvas);
    const sync = () => orb.setRunning(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    const rm = matchMedia("(prefers-reduced-motion: reduce)");
    orb.setStatic(rm.matches);
    rm.addEventListener("change", () => orb.setStatic(rm.matches));
  }
  dock.hidden = false;
  render();
})();
