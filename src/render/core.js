// Rendering core: renderer, golden-hour atmosphere shared by every shader, sky dome + image-based
// lighting, sun with a camera-following shadow frustum, and a compact HDR post chain
// (bloom, filmic tone map, grade, vignette, grain, FXAA) with adaptive resolution.
import * as THREE from 'three';

// ---------------------------------------------------------------------------- atmosphere
const SUN_ELEV = 24 * Math.PI / 180, SUN_AZ = 38 * Math.PI / 180;
export const SUN_DIR = new THREE.Vector3(
  Math.cos(SUN_ELEV) * Math.cos(SUN_AZ), Math.sin(SUN_ELEV), Math.cos(SUN_ELEV) * Math.sin(SUN_AZ),
).normalize();
const f3 = (v) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;

// Shared GLSL: sky radiance, haze colour and haze amount. Constants are baked in so that
// built-in materials need no extra uniforms.
export const ATMO_GLSL = /* glsl */`
const vec3 ATMO_SUN_DIR = ${f3(SUN_DIR)};
const vec3 ATMO_ZENITH = vec3(0.115, 0.215, 0.40);
const vec3 ATMO_HORIZON = vec3(0.52, 0.53, 0.52);
const vec3 ATMO_WARM = vec3(1.05, 0.66, 0.36);
const vec3 ATMO_SUN_COL = vec3(1.0, 0.80, 0.58);
const float ATMO_FOG_A = 0.0025;
const float ATMO_FOG_HAZE = 0.0007;
vec3 atmoSky(vec3 d) {
  float y = max(d.y, 0.0);
  float sd = max(dot(d, ATMO_SUN_DIR), 0.0);
  vec3 col = mix(ATMO_HORIZON, ATMO_ZENITH, pow(y, 0.45));
  vec2 dh = normalize(d.xz + vec2(1e-5));
  float sunH = max(dot(dh, normalize(ATMO_SUN_DIR.xz)), 0.0);
  col = mix(col, ATMO_WARM * 0.85, pow(1.0 - y, 7.0) * (0.22 + 0.6 * pow(sunH, 3.0)));
  col += ATMO_WARM * (pow(sd, 7.0) * 0.38 + pow(sd, 60.0) * 0.9);
  return col;
}
vec3 atmoFogColor(vec3 d) {
  return atmoSky(normalize(vec3(d.x, max(d.y, 0.0) * 0.3 + 0.03, d.z))) * 0.92;
}
float atmoFogAmount(vec3 camPos, vec3 worldPos) {
  vec3 v = worldPos - camPos;
  float dist = length(v);
  float dy = v.y / max(dist, 1e-4);
  const float b = 0.032;
  float base = ATMO_FOG_A * exp(-b * max(camPos.y, 0.0));
  float k = dist * dy * b;
  float integ = abs(k) > 1e-3 ? dist * (1.0 - exp(-k)) / k : dist;
  return 1.0 - exp(-(base * integ + ATMO_FOG_HAZE * dist));
}
vec3 atmoApply(vec3 col, vec3 camPos, vec3 worldPos) {
  float a = atmoFogAmount(camPos, worldPos);
  return mix(col, atmoFogColor(normalize(worldPos - camPos)), a);
}
`;

// Replace three's distance fog with the height-aware, sun-tinted haze above.
export function installAtmosphere() {
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorld = cameraPosition + ( mvPosition.xyz * mat3( viewMatrix ) );
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogDensity;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  ${ATMO_GLSL}
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  gl_FragColor.rgb = atmoApply( gl_FragColor.rgb, cameraPosition, vFogWorld );
#endif`;
}

const NOISE_GLSL = /* glsl */`
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float fbm4(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.9375;
}`;

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uEnv: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = viewMatrix * vec4(position, 0.0);
        gl_Position = projectionMatrix * vec4(p.xyz, 1.0);
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform float uTime; uniform float uEnv;
      ${ATMO_GLSL}
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = atmoSky(d);
        if (d.y > 0.0) {
          vec2 p = d.xz / (d.y + 0.16) * 1.15 + vec2(uTime * 0.0035, uTime * 0.0012);
          float c = fbm4(p);
          float cov = smoothstep(0.5, 0.82, c) * smoothstep(0.0, 0.14, d.y);
          float c2 = fbm4(p + ATMO_SUN_DIR.xz * 0.22);
          float lit = clamp((c - c2) * 3.2 + 0.55, 0.0, 1.0);
          vec3 cc = mix(vec3(0.30, 0.32, 0.38), vec3(1.15, 0.92, 0.72), lit);
          col = mix(col, cc, cov * 0.85);
          float sd = max(dot(d, ATMO_SUN_DIR), 0.0);
          float disk = smoothstep(0.99955, 0.99985, sd);
          col += ATMO_SUN_COL * disk * mix(22.0, 2.5, uEnv) * (1.0 - cov);
        } else if (uEnv > 0.5) {
          col = mix(atmoSky(vec3(d.x, 0.0, d.z)) * 0.55, vec3(0.075, 0.08, 0.055), smoothstep(0.0, -0.25, d.y));
        }
        // the visible sky melts into the haze colour at and below the horizon, so distant sea has no seam
        if (uEnv < 0.5) col = mix(atmoFogColor(d), col, smoothstep(0.0, 0.07, d.y));
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), mat);
  // drawn after all solid geometry so only uncovered pixels pay for the cloud noise
  mesh.frustumCulled = false; mesh.renderOrder = 1000;
  return mesh;
}

// ---------------------------------------------------------------------------- post chain
const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

class Post {
  constructor(renderer) {
    this.renderer = renderer;
    const gl = renderer.getContext();
    this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.bloomOn = true;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(geo, null);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.w = 2; this.h = 2;
    this.rtScene = this._rt(2, 2, true);
    this.rtDown = [this._rt(2, 2), this._rt(2, 2), this._rt(2, 2)];   // 1/4, 1/8, 1/16 resolution
    this.rtUp = [this._rt(2, 2), this._rt(2, 2)];                      // 1/4, 1/8
    const mk = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false, fog: false });
    this.mDown = mk(/* glsl */`
      varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThresh;
      void main() {
        vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1, -1)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1, -1)).rgb
               + texture2D(tSrc, vUv + uTexel * vec2(-1, 1)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1, 1)).rgb;
        c *= 0.25;
        if (uThresh > 0.0) {
          float br = max(c.r, max(c.g, c.b));
          float soft = clamp(br - uThresh + 0.5, 0.0, 1.0);
          soft = soft * soft * 0.5;
          c *= max(soft, br - uThresh) / max(br, 1e-4);
          c = min(c, vec3(24.0));
        }
        gl_FragColor = vec4(c, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: 0 } });
    this.mUp = mk(/* glsl */`
      varying vec2 vUv; uniform sampler2D tSrc; uniform sampler2D tAdd; uniform vec2 uTexel;
      void main() {
        vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1, -1)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1, -1)).rgb
               + texture2D(tSrc, vUv + uTexel * vec2(-1, 1)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1, 1)).rgb;
        gl_FragColor = vec4(c * 0.25 + texture2D(tAdd, vUv).rgb, 1.0);
      }`, { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.mFinal = mk(/* glsl */`
      varying vec2 vUv;
      uniform sampler2D tScene; uniform sampler2D tBloom;
      uniform vec2 uTexel; uniform float uExposure; uniform float uBloom; uniform float uTime;
      uniform float uSat; uniform float uVignette; uniform vec3 uTint; uniform float uTintAmt; uniform float uFxaa;
      vec3 aces(vec3 x) {
        x *= 0.74;
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }
      vec3 bloomC;
      vec3 tm(vec2 uv) { return aces((texture2D(tScene, uv).rgb + bloomC) * uExposure); }
      float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
      void main() {
        bloomC = texture2D(tBloom, vUv).rgb * uBloom;
        vec3 col = tm(vUv);
        if (uFxaa > 0.5) {
          vec3 nw = tm(vUv + uTexel * vec2(-1, -1)), ne = tm(vUv + uTexel * vec2(1, -1));
          vec3 sw = tm(vUv + uTexel * vec2(-1, 1)), se = tm(vUv + uTexel * vec2(1, 1));
          float lNW = luma(nw), lNE = luma(ne), lSW = luma(sw), lSE = luma(se), lM = luma(col);
          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
          if (lMax - lMin > max(0.035, lMax * 0.11)) {
            vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
            float red = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
            float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
            dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
            vec3 a = 0.5 * (tm(vUv + dir * (1.0 / 3.0 - 0.5)) + tm(vUv + dir * (2.0 / 3.0 - 0.5)));
            vec3 b = a * 0.5 + 0.25 * (tm(vUv + dir * -0.5) + tm(vUv + dir * 0.5));
            float lB = luma(b);
            col = (lB < lMin || lB > lMax) ? a : b;
          }
        }
        // grade: gentle teal shadows, warm highlights, slightly desaturated, a touch of contrast
        float l = luma(col);
        col = mix(vec3(l), col, uSat);
        col *= mix(vec3(0.94, 1.0, 1.05), vec3(1.05, 1.0, 0.93), smoothstep(0.05, 0.85, l));
        col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
        col = mix(col, uTint * l * 1.4, uTintAmt);
        vec2 q = vUv - 0.5;
        col *= 1.0 - uVignette * smoothstep(0.25, 0.95, dot(q, q) * 2.0);
        float gr = fract(sin(dot(vUv * vec2(1920.0, 1080.0) + uTime * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
        col += (gr - 0.5) * 0.028 * (1.0 - l * 0.6);
        gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
      }`, {
      tScene: { value: null }, tBloom: { value: null }, uTexel: { value: new THREE.Vector2() },
      uExposure: { value: 1.0 }, uBloom: { value: 0.11 }, uTime: { value: 0 }, uSat: { value: 0.9 },
      uVignette: { value: 0.3 }, uTint: { value: new THREE.Color(0.2, 0.45, 1.0) }, uTintAmt: { value: 0 }, uFxaa: { value: 1 },
    });
  }

  _rt(w, h, depth) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: !!depth, stencilBuffer: false, generateMipmaps: false,
    });
  }

  setSize(w, h) {
    w = Math.max(2, Math.floor(w)); h = Math.max(2, Math.floor(h));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.rtScene.setSize(w, h);
    let bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
    for (let i = 0; i < 3; i++) { bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1); this.rtDown[i].setSize(bw, bh); if (i < 2) this.rtUp[i].setSize(bw, bh); }
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  render(scene, camera, time) {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);
    if (this.bloomOn) {
      // bright-pass straight down to quarter resolution (4 bilinear taps cover a 4x4 block), then 1/8 and 1/16
      let src = this.rtScene;
      for (let i = 0; i < 3; i++) {
        const k = i === 0 ? 1.0 : 0.5;
        this.mDown.uniforms.tSrc.value = src.texture;
        this.mDown.uniforms.uTexel.value.set(k / src.width, k / src.height);
        this.mDown.uniforms.uThresh.value = i === 0 ? 1.05 : 0;
        this._pass(this.mDown, this.rtDown[i]);
        src = this.rtDown[i];
      }
      let low = this.rtDown[2];
      for (let i = 1; i >= 0; i--) {
        this.mUp.uniforms.tSrc.value = low.texture;
        this.mUp.uniforms.tAdd.value = this.rtDown[i].texture;
        this.mUp.uniforms.uTexel.value.set(0.5 / low.width, 0.5 / low.height);
        this._pass(this.mUp, this.rtUp[i]);
        low = this.rtUp[i];
      }
    }
    const u = this.mFinal.uniforms;
    u.tScene.value = this.rtScene.texture;
    u.tBloom.value = this.rtUp[0].texture;
    u.uBloom.value = this.bloomOn ? this.bloomAmt || 0.11 : 0;
    u.uTexel.value.set(1 / this.w, 1 / this.h);
    u.uTime.value = time % 100;
    this._pass(this.mFinal, null);
  }
}

// ---------------------------------------------------------------------------- renderer
export function createCore(canvas, opts = {}) {
  installAtmosphere();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;       // refreshed on a schedule in core.render
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x8a8a86, 0.002); // only switches the haze chunks on; the maths is baked above
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.12, 2600);
  camera.rotation.order = 'YXZ';

  const sky = makeSky();
  sky.scale.setScalar(2400);
  scene.add(sky);

  // image-based lighting from the same sky
  {
    const envScene = new THREE.Scene();
    const envSky = makeSky();
    envSky.material.uniforms.uEnv.value = 1;
    envSky.scale.setScalar(50);
    envScene.add(envSky);
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(envScene, 0.02, 0.1, 100).texture;
    scene.environmentIntensity = 1.0;
    pm.dispose();
    envSky.geometry.dispose(); envSky.material.dispose();
  }

  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.77, 0.53), 6.2);
  sun.castShadow = true;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.07;
  sun.shadow.radius = 2.4;
  scene.add(sun); scene.add(sun.target);
  const fill = new THREE.HemisphereLight(new THREE.Color(0.46, 0.55, 0.72), new THREE.Color(0.26, 0.22, 0.15), 0.4);
  scene.add(fill);

  // two pooled point lights for muzzle flashes (always present so shaders never recompile)
  const flashes = [];
  for (let i = 0; i < 2; i++) {
    const pl = new THREE.PointLight(new THREE.Color(1.0, 0.72, 0.38), 0, 16, 2);
    pl.position.set(0, -500, 0);
    scene.add(pl); flashes.push({ light: pl, t: 0 });
  }

  const post = new Post(renderer);
  const core = {
    renderer, scene, camera, sky, sun, post, flashes,
    quality: 'auto', renderScale: 0.85, shadowRange: 78, shadowSize: 2048, cssW: 2, cssH: 2,
    frameMs: 16.7, adaptT: 0, frameN: 0, shadowEvery: 2, shadowAt: new THREE.Vector3(),
  };
  const lx = new THREE.Vector3(), ly = new THREE.Vector3(), tmp = new THREE.Vector3();
  lx.set(-SUN_DIR.z, 0, SUN_DIR.x).normalize(); ly.crossVectors(SUN_DIR, lx).normalize();

  core.applyShadowSettings = function () {
    const sh = sun.shadow, R = core.shadowRange;
    if (sh.mapSize.x !== core.shadowSize) {
      sh.mapSize.set(core.shadowSize, core.shadowSize);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
    }
    sh.camera.left = -R; sh.camera.right = R; sh.camera.top = R; sh.camera.bottom = -R;
    sh.camera.near = 1; sh.camera.far = 520;
    sh.camera.updateProjectionMatrix();
  };

  // Keep the shadow frustum centred ahead of the camera, snapped to shadow texels to stop shimmer.
  core.updateShadow = function (cx, cy, cz) { core.shadowAt.set(cx, cy, cz); };
  function placeShadow() {
    const texel = (2 * core.shadowRange) / core.shadowSize;
    tmp.copy(core.shadowAt);
    const px = tmp.dot(lx), py = tmp.dot(ly);
    const sx = Math.round(px / texel) * texel - px, sy = Math.round(py / texel) * texel - py;
    tmp.addScaledVector(lx, sx).addScaledVector(ly, sy);
    sun.target.position.copy(tmp);
    sun.position.copy(tmp).addScaledVector(SUN_DIR, 260);
    sun.target.updateMatrixWorld();
  }

  core.setQuality = function (q) {
    core.quality = q;
    const P = {
      low: { scale: 0.66, shadow: 1024, range: 54, bloom: false, grass: 0.0, far: 0.55, every: 2 },
      medium: { scale: 0.8, shadow: 1536, range: 64, bloom: true, grass: 0.55, far: 0.75, every: 2 },
      high: { scale: 1.0, shadow: 2048, range: 80, bloom: true, grass: 1.0, far: 1.0, every: 1 },
      auto: { scale: 0.82, shadow: 1536, range: 66, bloom: true, grass: 0.7, far: 0.8, every: 2 },
    }[q] || {};
    core.renderScale = P.scale; core.shadowSize = P.shadow; core.shadowRange = P.range; core.shadowEvery = P.every;
    post.bloomOn = P.bloom; core.grassDensity = P.grass; core.detailFar = P.far;
    core.applyShadowSettings();
    core.resize(core.cssW, core.cssH);
    if (core.onQuality) core.onQuality(P);
  };

  core.resize = function (w, h) {
    core.cssW = w; core.cssH = h;
    renderer.setSize(w, h, false);
    post.setSize(w * core.renderScale, h * core.renderScale);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  // GPU timer queries (when the browser exposes them) tell us what a frame really costs, which a
  // vsync-locked frame interval cannot: 16.7 ms looks the same at 30% load and at 99%.
  const gl = renderer.getContext();
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let query = null, queryOpen = false;
  core.gpuMs = 0; core.gpuTimer = !!timerExt;
  function beginGpuTimer() {
    if (!timerExt) return;
    if (query) {
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
          const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
          core.gpuMs = core.gpuMs ? core.gpuMs + (ms - core.gpuMs) * 0.15 : ms;
        }
        gl.deleteQuery(query); query = null;
      }
      return;
    }
    query = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query); queryOpen = true;
  }
  function endGpuTimer() { if (queryOpen) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); queryOpen = false; } }

  // Auto quality: nudge internal resolution to hold the frame budget.
  core.adapt = function (frameMs, dt) {
    core.frameMs += (frameMs - core.frameMs) * 0.06;
    if (core.quality !== 'auto') return;
    core.adaptT += dt;
    if (core.adaptT < 1.5) return;
    core.adaptT = 0;
    let s = core.renderScale;
    if (core.gpuMs > 0) {
      if (core.gpuMs > 12.5) s -= core.gpuMs > 17 ? 0.1 : 0.05;
      else if (core.gpuMs < 8.0 && core.frameMs < 19.5) s += 0.05;
    } else if (core.frameMs > 19.5) s -= core.frameMs > 26 ? 0.1 : 0.05;
    s = Math.max(0.55, Math.min(1.0, Math.round(s * 20) / 20));
    if (s !== core.renderScale) {
      core.renderScale = s;
      post.setSize(core.cssW * s, core.cssH * s);
    }
    post.bloomOn = s > 0.6;
  };

  core.render = function (time, dt) {
    renderer.info.reset();
    // the shadow map is refreshed every `shadowEvery` frames; the sun only moves on those frames,
    // so the stored shadow matrix always matches the map being sampled
    core.frameN++;
    if (core.frameN % core.shadowEvery === 0 || core.frameN < 4) { placeShadow(); renderer.shadowMap.needsUpdate = true; }
    sky.position.copy(camera.position);
    sky.material.uniforms.uTime.value = time;
    for (const f of flashes) {
      if (f.t > 0) { f.t -= dt; f.light.intensity = f.t > 0 ? f.peak * (f.t / f.dur) : 0; }
    }
    beginGpuTimer();
    post.render(scene, camera, time);
    endGpuTimer();
  };

  core.flash = function (x, y, z, power) {
    let f = flashes[0].t <= flashes[1].t ? flashes[0] : flashes[1];
    f.light.position.set(x, y, z); f.peak = power; f.dur = 0.06; f.t = 0.06; f.light.intensity = power;
  };

  core.applyShadowSettings();
  return core;
}

export { NOISE_GLSL };
