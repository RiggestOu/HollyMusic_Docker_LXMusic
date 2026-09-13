/**
 * WebGL 2.0 粒子渲染器（降级路径）—— three.js Points + 顶点着色器位移。
 *
 * 为什么不用 Transform Feedback：
 *   本系统的粒子运动是 (初始位置, 时间, 音频特征) 的纯函数，不存在需要跨帧
 *   持久化的状态。Transform Feedback 的 ping-pong 缓冲每帧要读写两遍显存，
 *   相比在 vertex shader 里直接求值多两次带宽往返，且实现复杂度显著更高。
 *   这里在 GPU 顶点阶段完成全部计算：CPU 负载为零，无需显存回读。
 *   若将来引入需要状态积分的力场模拟，可在 ParticleRenderer 接口下新增
 *   Transform Feedback 实现，上层无需改动。
 *
 * 视觉参数（配色、律动系数）与 webgpu.ts 保持一致，确保两条路径观感统一。
 */

import * as THREE from 'three'
import type { AudioFeatures, CameraState, ParticleRenderer, ParticleRendererOptions } from './types'

/** 与 WGSL 路径一致的配色（香槟金 / 薄荷绿 / 近黑）。 */
const COLOR_CHAMPAGNE = new THREE.Color('#F7E7CE')
const COLOR_MINT = new THREE.Color('#A8E6CF')
const COLOR_BG = new THREE.Color('#08080C')

const VERTEX_SHADER = /* glsl */ `
  precision highp float;
  attribute float aRand;
  attribute float aScale;
  uniform float uTime, uBass, uMid, uTreble, uEnergy, uBeat;
  uniform float uPointSize, uPixel;
  uniform vec3 uColorA, uColorB;
  varying vec3 vColor;
  varying float vGlow;
  varying float vAlpha;

  // ---- 3D Simplex Noise（Ashima / Gustavson）——平滑流场的基础 ----
  vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  // 平滑流场：三分量噪声构成无棱角的连续速度场（流体 / 烟雾感来源）
  vec3 flowField(vec3 p, float t) {
    float f = 0.13;
    float tt = t * 0.14;
    return vec3(
      snoise(p * f + vec3(0.0, 0.0, tt)),
      snoise(p * f + vec3(31.4, 17.2, tt)),
      snoise(p * f + vec3(71.7, 53.1, tt))
    );
  }

  void main() {
    vec3 base = position;
    vec3 dir = normalize(base + vec3(1e-4));

    // 流体位移：沿噪声流场平滑流动（曲线轨迹，非折线）
    vec3 flow = flowField(base, uTime);
    float flowAmp = 1.15 + uBass * 2.4 + uMid * 0.9;
    vec3 p = base + flow * flowAmp;

    // 呼吸：smoothstep 缓动的径向外扩，杜绝突变
    float breathe = smoothstep(0.0, 1.0, 0.5 + 0.5 * sin(uTime * 0.55 + aRand * 6.2831));
    p += dir * breathe * (0.25 + uBass * 1.5);

    // 高频细颤：同样由噪声驱动，保持平滑
    p += flowField(base * 2.7, uTime * 2.2) * (uTreble * 0.55);

    // 节拍：缓动上抬
    p.y += smoothstep(0.0, 1.0, uBeat) * 0.22;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // 尺寸：缓动过渡，避免阶梯式跳变
    float pulse = smoothstep(0.0, 1.0, uBeat);
    float size = uPointSize * (0.5 + aScale * 0.8)
               * (1.0 + pulse * 0.55 + smoothstep(0.0, 1.0, uEnergy) * 0.3);
    gl_PointSize = clamp(size * uPixel * (300.0 / max(0.001, -mv.z)), 0.8, 34.0);

    // 颜色：smoothstep 过渡（香槟金 ↔ 薄荷绿），非硬切
    float ct = clamp(smoothstep(0.15, 0.85, aRand + uEnergy * 0.3 - 0.1), 0.0, 1.0);
    vColor = mix(uColorA, uColorB, ct);
    vGlow = smoothstep(0.0, 1.0, uBass * 0.75 + uTreble * 0.45 + uBeat * 0.5);
    vAlpha = 0.55 + 0.45 * smoothstep(0.0, 1.0, 0.35 + uEnergy * 0.6);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vGlow;
  varying float vAlpha;

  void main() {
    // 径向渐变柔光：exp 高斯核 + 边缘 smoothstep 淡出
    // 相比硬阈值 smoothstep(0.5, 0.08, d)，这里没有可见边界，呈雾状光晕
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c) * 2.0;
    float core = exp(-d * d * 3.0);
    float edge = 1.0 - smoothstep(0.72, 1.0, d);
    float a = core * edge;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * (0.55 + vGlow * 0.85), a * vAlpha * uOpacity);
  }
`

export function createWebGL2Renderer(options: ParticleRendererOptions): ParticleRenderer {
  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.touchAction = 'none'
  options.container.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(COLOR_BG, 1)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)

  const count = options.count
  const radius = options.radius ?? 6
  const positions = new Float32Array(count * 3)
  const aRand = new Float32Array(count)
  const aScale = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const u = Math.random()
    const v = Math.random()
    const theta = u * Math.PI * 2
    const phi = Math.acos(2 * v - 1)
    const r = radius * (0.62 + Math.random() * 0.38)
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)
    aRand[i] = Math.random()
    aScale[i] = 0.35 + Math.random() * 0.9
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aRand', new THREE.BufferAttribute(aRand, 1))
  geometry.setAttribute('aScale', new THREE.BufferAttribute(aScale, 1))

  const uniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uEnergy: { value: 0 },
    uBeat: { value: 0 },
    uPointSize: { value: options.pointSize },
    uPixel: { value: renderer.getPixelRatio() },
    uColorA: { value: COLOR_CHAMPAGNE.clone() },
    uColorB: { value: COLOR_MINT.clone() },
    uOpacity: { value: 1 },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  scene.add(points)

  return {
    backend: 'webgl2',
    count,
    resize(width: number, height: number) {
      const w = Math.max(1, Math.floor(width))
      const h = Math.max(1, Math.floor(height))
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      uniforms.uPixel.value = renderer.getPixelRatio()
    },
    update(features: AudioFeatures, c: CameraState) {
      uniforms.uTime.value = features.time
      uniforms.uBass.value = features.bass
      uniforms.uMid.value = features.mid
      uniforms.uTreble.value = features.treble
      uniforms.uEnergy.value = features.energy
      uniforms.uBeat.value = features.beat

      const sp = Math.sin(c.phi)
      camera.position.set(
        c.target[0] + c.radius * sp * Math.sin(c.theta),
        c.target[1] + c.radius * Math.cos(c.phi),
        c.target[2] + c.radius * sp * Math.cos(c.theta),
      )
      camera.lookAt(c.target[0], c.target[1], c.target[2])
    },
    render() {
      renderer.render(scene, camera)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      canvas.remove()
    },
  }
}
