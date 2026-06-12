// Animated grainy multi-colour gradient ("grainient") — the reactbits.dev
// "Grainient" shader (David Haz, react-bits, MIT), raw WebGL2, zero deps.
// Ported from chain-builder's Vue port (docs/site GrainientBackground.vue);
// same fragment shader, same uniform tuning VERBATIM, brand palette
// #F59E0B / #EA580C / #201712.
//
// Native behavior component: `behavior` is bundled into _directives.js and
// runs client-side; the default export is the static <canvas> host the
// compiler inlines into Home (inline `<GrainientBackground native />`, auto
// x-data). ctx.el IS the canvas.
//
// - prefers-reduced-motion → render exactly ONE frame, no RAF loop
//   (resize re-draws that single frame so it stays crisp).
// - WebGL2 unavailable → add `.grainient-fallback` to the canvas's PARENT
//   (static CSS gradient in the same trio — app.css).
// - Resize via ResizeObserver; `webglcontextlost` stops the loop.
// - All teardown lives in the ctx.effect cleanup (auto-disposed on
//   unmount/SPA-nav): RAF, observer, listeners, context release.
import type { BehaviorCtx } from 'brustjs/native'

// brand grainient palette
const COLOR1 = '#F59E0B' // amber
const COLOR2 = '#EA580C' // ember
const COLOR3 = '#201712' // ink
const TIME_SPEED = 0.5
const WARP_SPEED = 0.6

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return [1, 1, 1]
  return [
    Number.parseInt(m[1]!, 16) / 255,
    Number.parseInt(m[2]!, 16) / 255,
    Number.parseInt(m[3]!, 16) / 255,
  ]
}

const VERT = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uTimeSpeed;
uniform float uColorBalance;
uniform float uWarpStrength;
uniform float uWarpFrequency;
uniform float uWarpSpeed;
uniform float uWarpAmplitude;
uniform float uBlendAngle;
uniform float uBlendSoftness;
uniform float uRotationAmount;
uniform float uNoiseScale;
uniform float uGrainAmount;
uniform float uGrainScale;
uniform float uGrainAnimated;
uniform float uContrast;
uniform float uGamma;
uniform float uSaturation;
uniform vec2 uCenterOffset;
uniform float uZoom;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
out vec4 fragColor;
#define S(a,b,t) smoothstep(a,b,t)
mat2 Rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
vec2 hash(vec2 p){p=vec2(dot(p,vec2(2127.1,81.17)),dot(p,vec2(1269.5,283.37)));return fract(sin(p)*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);float n=mix(mix(dot(-1.0+2.0*hash(i+vec2(0.0,0.0)),f-vec2(0.0,0.0)),dot(-1.0+2.0*hash(i+vec2(1.0,0.0)),f-vec2(1.0,0.0)),u.x),mix(dot(-1.0+2.0*hash(i+vec2(0.0,1.0)),f-vec2(0.0,1.0)),dot(-1.0+2.0*hash(i+vec2(1.0,1.0)),f-vec2(1.0,1.0)),u.x),u.y);return 0.5+0.5*n;}
void mainImage(out vec4 o, vec2 C){
  float t=iTime*uTimeSpeed;
  vec2 uv=C/iResolution.xy;
  float ratio=iResolution.x/iResolution.y;
  vec2 tuv=uv-0.5+uCenterOffset;
  tuv/=max(uZoom,0.001);
  float degree=noise(vec2(t*0.1,tuv.x*tuv.y)*uNoiseScale);
  tuv.y*=1.0/ratio;
  tuv*=Rot(radians((degree-0.5)*uRotationAmount+180.0));
  tuv.y*=ratio;
  float frequency=uWarpFrequency;
  float ws=max(uWarpStrength,0.001);
  float amplitude=uWarpAmplitude/ws;
  float warpTime=t*uWarpSpeed;
  tuv.x+=sin(tuv.y*frequency+warpTime)/amplitude;
  tuv.y+=sin(tuv.x*(frequency*1.5)+warpTime)/(amplitude*0.5);
  vec3 colLav=uColor1;
  vec3 colOrg=uColor2;
  vec3 colDark=uColor3;
  float b=uColorBalance;
  float s=max(uBlendSoftness,0.0);
  mat2 blendRot=Rot(radians(uBlendAngle));
  float blendX=(tuv*blendRot).x;
  float edge0=-0.3-b-s;
  float edge1=0.2-b+s;
  float v0=0.5-b+s;
  float v1=-0.3-b-s;
  vec3 layer1=mix(colDark,colOrg,S(edge0,edge1,blendX));
  vec3 layer2=mix(colOrg,colLav,S(edge0,edge1,blendX));
  vec3 col=mix(layer1,layer2,S(v0,v1,tuv.y));
  vec2 grainUv=uv*max(uGrainScale,0.001);
  if(uGrainAnimated>0.5){grainUv+=vec2(iTime*0.05);}
  float grain=fract(sin(dot(grainUv,vec2(12.9898,78.233)))*43758.5453);
  col+=(grain-0.5)*uGrainAmount;
  col=(col-0.5)*uContrast+0.5;
  float luma=dot(col,vec3(0.2126,0.7152,0.0722));
  col=mix(vec3(luma),col,uSaturation);
  col=pow(max(col,0.0),vec3(1.0/max(uGamma,0.001)));
  col=clamp(col,0.0,1.0);
  o=vec4(col,1.0);
}
void main(){ vec4 o=vec4(0.0); mainImage(o,gl_FragCoord.xy); fragColor=o; }
`

// static uniform tuning — VERBATIM from the chain-builder/reactbits reference
const STATIC_UNIFORMS: Record<string, number | number[]> = {
  uTimeSpeed: TIME_SPEED,
  uColorBalance: 0.0,
  uWarpStrength: 1.0,
  uWarpFrequency: 5.0,
  uWarpSpeed: WARP_SPEED,
  uWarpAmplitude: 50.0,
  uBlendAngle: 0.0,
  uBlendSoftness: 0.05,
  uRotationAmount: 500.0,
  uNoiseScale: 2.0,
  uGrainAmount: 0.1,
  uGrainScale: 2.0,
  uGrainAnimated: 0.0,
  uContrast: 1.5,
  uGamma: 1.0,
  uSaturation: 1.0,
  uZoom: 0.9,
  uCenterOffset: [0, 0],
  uColor1: hexToRgb(COLOR1),
  uColor2: hexToRgb(COLOR2),
  uColor3: hexToRgb(COLOR3),
}

function compileShader(g: WebGL2RenderingContext, type: number, src: string) {
  const sh = g.createShader(type)
  if (!sh) return null
  g.shaderSource(sh, src)
  g.compileShader(sh)
  return sh
}

export const behavior = ({ el, effect }: BehaviorCtx) => {
  effect(() => {
    const cv = el as HTMLCanvasElement
    const fallback = () => cv.parentElement?.classList.add('grainient-fallback')

    const gl = cv.getContext('webgl2', { antialias: false, alpha: true })
    if (!gl) {
      fallback()
      return
    }
    const g = gl

    const prog = g.createProgram()
    const vert = compileShader(g, g.VERTEX_SHADER, VERT)
    const frag = compileShader(g, g.FRAGMENT_SHADER, FRAG)
    if (!prog || !vert || !frag) {
      fallback()
      return
    }
    g.attachShader(prog, vert)
    g.attachShader(prog, frag)
    g.linkProgram(prog)
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram — not a React hook
    g.useProgram(prog)

    // fullscreen triangle
    const buf = g.createBuffer()
    g.bindBuffer(g.ARRAY_BUFFER, buf)
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW)
    const loc = g.getAttribLocation(prog, 'position')
    g.enableVertexAttribArray(loc)
    g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)

    // set the static uniforms once
    for (const [name, value] of Object.entries(STATIC_UNIFORMS)) {
      const u = g.getUniformLocation(prog, name)
      if (u === null) continue
      if (Array.isArray(value)) {
        if (value.length === 2) g.uniform2fv(u, value)
        else g.uniform3fv(u, value)
      } else {
        g.uniform1f(u, value)
      }
    }

    const uRes = g.getUniformLocation(prog, 'iResolution')
    const uTime = g.getUniformLocation(prog, 'iTime')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = performance.now()
    let raf = 0
    let lost = false

    const draw = () => {
      g.uniform1f(uTime, (performance.now() - start) / 1000)
      g.drawArrays(g.TRIANGLES, 0, 3)
    }
    const loop = () => {
      draw()
      raf = requestAnimationFrame(loop)
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.floor(cv.clientWidth * dpr))
      const h = Math.max(1, Math.floor(cv.clientHeight * dpr))
      cv.width = w
      cv.height = h
      g.viewport(0, 0, w, h)
      g.uniform2f(uRes, w, h)
      // reduced motion shows a single static frame — keep it crisp on resize
      if (reduced && !lost) draw()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(cv)
    resize()

    const onContextLost = (e: Event) => {
      e.preventDefault()
      lost = true
      cancelAnimationFrame(raf)
    }
    cv.addEventListener('webglcontextlost', onContextLost)

    // pause when the tab is hidden
    const onVisibility = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden && !lost) raf = requestAnimationFrame(loop)
    }

    if (reduced) {
      draw() // exactly one frame, no RAF loop
    } else {
      document.addEventListener('visibilitychange', onVisibility)
      loop()
    }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      cv.removeEventListener('webglcontextlost', onContextLost)
      document.removeEventListener('visibilitychange', onVisibility)
      // Explicit GPU-object deletion BEFORE loseContext: drivers may defer
      // reclamation after loseContext alone, which leaks shaders/buffers
      // across repeated SPA navs to Home.
      g.detachShader(prog, vert)
      g.detachShader(prog, frag)
      g.deleteShader(vert)
      g.deleteShader(frag)
      g.deleteBuffer(buf)
      g.deleteProgram(prog)
      g.getExtension('WEBGL_lose_context')?.loseContext()
    }
  })

  return {}
}

// default → jinja (server): the static canvas host. Position/size comes from
// `.grainient` in app.css (absolute inset-0 inside the relative hero).
export default function GrainientBackground() {
  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: purely decorative canvas; not focusable (no tabindex/content)
  return <canvas className="grainient" aria-hidden="true" />
}
