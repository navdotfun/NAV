/* ============================================================================
   HeroField — R4.1 GPU cinematic layer (lazy chunk, progressive enhancement).

   A market-depth surface: a single Points draw call, a 168×76 grid displaced
   in the vertex shader by layered sines — a liquidity book breathing under
   the exchange floor. Phosphor green crests, brushed-silver troughs, fading
   into the silver page. Institutional restraint: one object, one material,
   no post-processing, no controls.

   Contract (owner directive):
   - loaded via React.lazy AFTER first paint — the DOM hero stands alone;
   - renders nothing if WebGL context creation fails;
   - pixel ratio capped at 2;
   - RAF pauses when the canvas leaves the viewport (IntersectionObserver)
     or the tab hides (visibilitychange);
   - full dispose on unmount — geometry, material, renderer, observers.
   Gating for reduced-motion / small screens / low-power happens in Home.tsx
   before the dynamic import is even requested.
   ========================================================================== */
import { useEffect, useRef } from "react";
import * as THREE from "three";

const VERT = /* glsl */ `
  uniform float uTime;
  varying float vCrest;
  varying float vDepth;

  float wave(vec2 p, float t) {
    return
      0.38 * sin(p.x * 0.55 + t * 0.50) * cos(p.y * 0.42 - t * 0.31)
    + 0.22 * sin(p.x * 1.15 - t * 0.42 + p.y * 0.65)
    + 0.12 * sin(p.y * 1.85 + t * 0.65)
    + 0.06 * sin((p.x + p.y) * 2.9 - t * 0.9);
  }

  void main() {
    vec3 pos = position;
    float h = wave(pos.xz, uTime);
    /* the book deepens away from the lens */
    pos.y += h * (0.55 + 0.045 * (pos.z * -1.0 + 8.0));
    vCrest = clamp(h * 0.9 + 0.5, 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vDepth = clamp((-mv.z - 3.0) / 16.0, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (34.0 / -mv.z) * (0.75 + 0.5 * vCrest);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uGreen;   /* #00c805 crest phosphor */
  uniform vec3 uDeep;    /* #009a39 body green */
  uniform vec3 uSilver;  /* #aeb9c2 trough metal */
  varying float vCrest;
  varying float vDepth;

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;                     /* square -> disc */
    float core = smoothstep(0.5, 0.12, r);    /* soft dot */
    vec3 col = mix(uSilver, uDeep, smoothstep(0.35, 0.75, vCrest));
    col = mix(col, uGreen, smoothstep(0.72, 1.0, vCrest));
    /* fade with distance into the silver page; crests carry more presence */
    float a = core * mix(0.52, 0.10, vDepth) * (0.45 + 0.55 * vCrest);
    gl_FragColor = vec4(col, a);
  }
`;

export default function HeroField({ className = "" }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
    } catch {
      return; /* no WebGL — the DOM hero already stands on its own */
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
    camera.position.set(0, 2.35, 8.4);
    camera.lookAt(0, 0.15, 0);

    /* points grid — one BufferGeometry, one draw call */
    const COLS = 168;
    const ROWS = 76;
    const W = 30;
    const D = 15;
    const positions = new Float32Array(COLS * ROWS * 3);
    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        positions[i++] = (c / (COLS - 1) - 0.5) * W;
        positions[i++] = 0;
        positions[i++] = (r / (ROWS - 1) - 0.5) * D - 1.5;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uGreen: { value: new THREE.Color("#00c805") },
        uDeep: { value: new THREE.Color("#009a39") },
        uSilver: { value: new THREE.Color("#aeb9c2") },
      },
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    /* sizing */
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    /* render loop — runs only while on-screen AND tab visible */
    let raf = 0;
    let inView = true;
    let alive = true;
    const clock = new THREE.Clock();
    let t = 0;
    const frame = () => {
      raf = 0;
      if (!alive || !inView || document.hidden) return;
      t += Math.min(clock.getDelta(), 0.05);
      material.uniforms.uTime.value = t;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      if (alive && !raf && inView && !document.hidden) {
        clock.getDelta(); /* swallow the pause */
        raf = requestAnimationFrame(frame);
      }
    };
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      wake();
    });
    io.observe(host);
    const onVis = () => wake();
    document.addEventListener("visibilitychange", onVis);
    wake();

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      io.disconnect();
      ro.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={hostRef} className={className} aria-hidden="true" />;
}
