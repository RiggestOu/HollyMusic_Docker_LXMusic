/**
 * WebGPU 粒子渲染器 —— Compute Shader 更新 + Instanced Billboard 绘制。
 *
 * 与 WebGL 2.0 路径的关键差异：
 *  · 粒子位置/速度在 GPU 的 storage buffer 中由 compute pass 积分更新（真正的状态演化）；
 *  · WebGPU 没有 gl_PointSize 等价物，point-list 只能绘制 1px 点，
 *    因此每个粒子以 6 顶点的实例化 quad 做 billboard 绘制（配合 camRight/camUp）。
 *
 * 两条路径共用同一套音频特征与镜头状态，保证视觉与交互一致。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three'
import type { AudioFeatures, CameraState, ParticleRenderer, ParticleRendererOptions } from './types'

type Any = any

/** 每个粒子 8 个 float：pos.xyz + seed + vel.xyz + scale（32 字节，满足 vec3 对齐）。 */
const FLOATS_PER_PARTICLE = 8

/**
 * WebGPU buffer usage 位标志。
 *
 * 这里不直接引用全局 `GPUBufferUsage`，因为那是 `@webgpu/types` 提供的声明，
 * 本项目根目录与 frontend 都没有引入该包（且本文件同时被两个 TS 工程编译），
 * 直接引用会导致 TS2304。数值来自 WebGPU 规范，写成常量可保持零新增依赖。
 */
const BUFFER_USAGE = {
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const

/** Uniform 布局（Float32Array 索引，严格 16 字节对齐）：
 *  0..15   viewProj(mat4)
 *  16..18  camRight   19 time
 *  20..22  camUp      23 dt
 *  24..27  bass, mid, treble, energy
 *  28..30  beat, radius, pointSize   31 pad
 *  32      count(u32)
 */
const UNIFORM_FLOATS = 36

const WGSL = /* wgsl */ `
struct Particle {
  pos: vec3<f32>,
  seed: f32,
  vel: vec3<f32>,
  scale: f32,
};

struct Uniforms {
  viewProj: mat4x4<f32>,
  camRight: vec3<f32>,
  time: f32,
  camUp: vec3<f32>,
  dt: f32,
  bass: f32,
  mid: f32,
  treble: f32,
  energy: f32,
  beat: f32,
  radius: f32,
  pointSize: f32,
  pad0: f32,
  count: u32,
};

fn mod289v3(x: vec3<f32>) -> vec3<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v4(x: vec4<f32>) -> vec4<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute4(x: vec4<f32>) -> vec4<f32> { return mod289v4(((x * 34.0) + 1.0) * x); }
fn taylorInvSqrt4(r: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(1.79284291400159) - vec4<f32>(0.85373472095314) * r;
}

// 3D Simplex Noise（Ashima / Gustavson 实现的 WGSL 移植）
fn snoise(v: vec3<f32>) -> f32 {
  let C = vec2<f32>(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4<f32>(0.0, 0.5, 1.0, 2.0);
  var i = floor(v + vec3<f32>(dot(v, vec3<f32>(C.y))));
  let x0 = v - i + vec3<f32>(dot(i, vec3<f32>(C.x)));
  let g = step(x0.yzx, x0.xyz);
  let l = vec3<f32>(1.0) - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);
  var x1 = x0 - i1 + vec3<f32>(C.x);
  var x2 = x0 - i2 + vec3<f32>(C.y);
  var x3 = x0 - vec3<f32>(D.y);
  i = mod289v3(i);
  let p = permute4(permute4(permute4(
      i.z + vec4<f32>(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4<f32>(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4<f32>(0.0, i1.x, i2.x, 1.0));
  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;
  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = vec4<f32>(1.0) - abs(x) - abs(y);
  let b0 = vec4<f32>(x.xy, y.xy);
  let b1 = vec4<f32>(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + vec4<f32>(1.0);
  let s1 = floor(b1) * 2.0 + vec4<f32>(1.0);
  let sh = -step(h, vec4<f32>(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;
  var p0 = vec3<f32>(a0.xy, h.x);
  var p1 = vec3<f32>(a0.zw, h.y);
  var p2 = vec3<f32>(a1.xy, h.z);
  var p3 = vec3<f32>(a1.zw, h.w);
  let norm = taylorInvSqrt4(vec4<f32>(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 = p0 * norm.x;
  p1 = p1 * norm.y;
  p2 = p2 * norm.z;
  p3 = p3 * norm.w;
  var m = max(
    vec4<f32>(0.6) - vec4<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)),
    vec4<f32>(0.0)
  );
  m = m * m;
  return 42.0 * dot(m * m, vec4<f32>(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// 平滑流场：三分量噪声构成无棱角的连续速度场（流体 / 烟雾感来源）
fn flowField(p: vec3<f32>, t: f32) -> vec3<f32> {
  let f = 0.13;
  let tt = t * 0.14;
  return vec3<f32>(
    snoise(p * f + vec3<f32>(0.0, 0.0, tt)),
    snoise(p * f + vec3<f32>(31.4, 17.2, tt)),
    snoise(p * f + vec3<f32>(71.7, 53.1, tt))
  );
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> u: Uniforms;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.count) { return; }

  var p = particles[i];
  let dir = normalize(p.pos + vec3<f32>(1e-4));
  let r = length(p.pos);
  let targetR = u.radius * (0.62 + p.seed * 0.38);

  // 弹簧：回归目标球壳半径（维持云团整体形状）
  var acc = dir * (targetR - r) * 2.2;
  // 噪声流场：流体 / 烟雾感的主要来源，轨迹为平滑曲线而非折线
  acc += flowField(p.pos, u.time) * (6.0 + u.bass * 14.0 + u.mid * 5.0);
  // 高频细颤：同样由噪声驱动，保持平滑
  acc += flowField(p.pos * 2.7, u.time * 2.2) * (u.treble * 10.0);
  // 低频外扩：呼吸式膨胀
  acc += dir * (u.bass * 9.0) * (0.5 + p.seed);

  p.vel = (p.vel + acc * u.dt) * 0.88;
  p.pos = p.pos + p.vel * u.dt;
  particles[i] = p;
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) glow: f32,
};

@group(0) @binding(0) var<storage, read> ro_particles: array<Particle>;
@group(0) @binding(1) var<uniform> ro_u: Uniforms;

// 粒子尺寸：基础尺寸 × 每粒子随机缩放。写成函数便于两条后端保持一致的表达。
fn u_pointSize(base: f32, scale: f32) -> f32 {
  return base * scale * 0.062;
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  let q = quad[vi];
  let p = ro_particles[ii];

  // 香槟金 → 薄荷绿
  let colA = vec3<f32>(0.968, 0.905, 0.807);
  let colB = vec3<f32>(0.658, 0.902, 0.811);

  let size = u_pointSize(ro_u.pointSize, p.scale);
  let world = p.pos + ro_u.camRight * (q.x * size) + ro_u.camUp * (q.y * size);

  var out: VSOut;
  out.pos = ro_u.viewProj * vec4<f32>(world, 1.0);
  out.uv = q;
  // 颜色：smoothstep 过渡（香槟金 ↔ 薄荷绿），非硬切
  out.color = mix(colA, colB, clamp(smoothstep(0.15, 0.85, p.seed + ro_u.energy * 0.3 - 0.1), 0.0, 1.0));
  // 辉光：缓动，避免随频谱跳变
  out.glow = smoothstep(0.0, 1.0, ro_u.bass * 0.75 + ro_u.treble * 0.45 + ro_u.beat * 0.5);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // 径向渐变柔光：高斯核 + 边缘 smoothstep 淡出
  // 相比硬阈值 smoothstep，这里没有可见边界，呈雾状光晕（星云 / 极光感）
  let d = length(in.uv);
  let core = exp(-d * d * 3.0);
  let edge = 1.0 - smoothstep(0.72, 1.0, d);
  let a = core * edge;
  if (a < 0.004) { discard; }
  return vec4<f32>(in.color * (0.55 + in.glow * 0.85), a);
}
`

export async function createWebGPURenderer(
  options: ParticleRendererOptions,
): Promise<ParticleRenderer> {
  const gpu = (navigator as Any).gpu
  if (!gpu) throw new Error('navigator.gpu 不可用')

  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter 请求失败')
  const device: Any = await adapter.requestDevice()

  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.touchAction = 'none'
  options.container.appendChild(canvas)

  const context: Any = canvas.getContext('webgpu')
  if (!context) throw new Error('无法获取 webgpu canvas context')
  const format = gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })

  const count = options.count
  const radius = options.radius ?? 6

  // ---------- 初始粒子数据 ----------
  const initial = new Float32Array(count * FLOATS_PER_PARTICLE)
  for (let i = 0; i < count; i++) {
    const u = Math.random()
    const v = Math.random()
    const theta = u * Math.PI * 2
    const phi = Math.acos(2 * v - 1)
    const r = radius * (0.62 + Math.random() * 0.38)
    const o = i * FLOATS_PER_PARTICLE
    initial[o] = r * Math.sin(phi) * Math.cos(theta)
    initial[o + 1] = r * Math.sin(phi) * Math.sin(theta)
    initial[o + 2] = r * Math.cos(phi)
    initial[o + 3] = Math.random()
    initial[o + 4] = 0
    initial[o + 5] = 0
    initial[o + 6] = 0
    initial[o + 7] = 0.35 + Math.random() * 0.9
  }

  const particleBuffer = device.createBuffer({
    size: initial.byteLength,
    usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
  })
  device.queue.writeBuffer(particleBuffer, 0, initial)

  const uniformData = new ArrayBuffer(UNIFORM_FLOATS * 4)
  const uniformF32 = new Float32Array(uniformData)
  const uniformU32 = new Uint32Array(uniformData)
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
  })
  uniformU32[32] = count

  // ---------- 管线 ----------
  const module = device.createShaderModule({ code: WGSL })

  const computePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'cs_main' },
  })

  const renderPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [
        {
          format,
          blend: {
            // 与 WebGL 路径一致：加法混合，营造辉光
            color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  })

  const computeBindGroup = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: uniformBuffer } },
    ],
  })
  const renderBindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: uniformBuffer } },
    ],
  })

  // ---------- 相机（复用 three 的数学工具，不创建渲染器） ----------
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200)
  const projView = new THREE.Matrix4()
  const viewMatrix = new THREE.Matrix4()
  const camRight = new THREE.Vector3()
  const camUp = new THREE.Vector3()
  const camForward = new THREE.Vector3()
  const upHint = new THREE.Vector3(0, 1, 0)

  let lastTime = -1
  let width = 1
  let height = 1

  const writeUniforms = (f: AudioFeatures, c: CameraState) => {
    const sp = Math.sin(c.phi)
    camera.position.set(
      c.target[0] + c.radius * sp * Math.sin(c.theta),
      c.target[1] + c.radius * Math.cos(c.phi),
      c.target[2] + c.radius * sp * Math.cos(c.theta),
    )
    camera.up.copy(upHint)
    camera.lookAt(c.target[0], c.target[1], c.target[2])
    camera.aspect = width / Math.max(1, height)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)

    viewMatrix.copy(camera.matrixWorldInverse)
    projView.multiplyMatrices(camera.projectionMatrix, viewMatrix)

    camForward.set(0, 0, -1).applyQuaternion(camera.quaternion)
    camRight.set(1, 0, 0).applyQuaternion(camera.quaternion)
    camUp.crossVectors(camRight, camForward).normalize()

    for (let i = 0; i < 16; i++) uniformF32[i] = projView.elements[i]
    uniformF32[16] = camRight.x
    uniformF32[17] = camRight.y
    uniformF32[18] = camRight.z
    uniformF32[19] = f.time
    uniformF32[20] = camUp.x
    uniformF32[21] = camUp.y
    uniformF32[22] = camUp.z
    const dt = lastTime < 0 ? 1 / 60 : Math.min(0.05, Math.max(0.001, f.time - lastTime))
    lastTime = f.time
    uniformF32[23] = dt
    uniformF32[24] = f.bass
    uniformF32[25] = f.mid
    uniformF32[26] = f.treble
    uniformF32[27] = f.energy
    uniformF32[28] = f.beat
    uniformF32[29] = radius
    uniformF32[30] = options.pointSize
    uniformF32[31] = 0
    uniformU32[32] = count

    device.queue.writeBuffer(uniformBuffer, 0, uniformData)
  }

  return {
    backend: 'webgpu',
    count,
    resize(w: number, h: number) {
      width = Math.max(1, Math.floor(w))
      height = Math.max(1, Math.floor(h))
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
    },
    update(features: AudioFeatures, c: CameraState) {
      writeUniforms(features, c)
    },
    render() {
      const encoder: Any = device.createCommandEncoder()
      const workgroups = Math.ceil(count / 64)
      const pass = encoder.beginComputePass()
      pass.setPipeline(computePipeline)
      pass.setBindGroup(0, computeBindGroup)
      pass.dispatchWorkgroups(workgroups)
      pass.end()

      const view = context.getCurrentTexture().createView()
      const rp: Any = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: 0.031, g: 0.031, b: 0.047, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      rp.setPipeline(renderPipeline)
      rp.setBindGroup(0, renderBindGroup)
      rp.draw(6, count)
      rp.end()

      device.queue.submit([encoder.finish()])
    },
    dispose() {
      particleBuffer.destroy?.()
      uniformBuffer.destroy?.()
      canvas.remove()
    },
  }
}
