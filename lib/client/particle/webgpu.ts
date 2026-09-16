/**
 * WebGPU 粒子渲染器 —— Compute Shader 更新 + Instanced Billboard 绘制。
 *
 * 与 WebGL 2.0 路径的关键差异：
 *  · 粒子位置/速度在 GPU 的 storage buffer 中由 compute pass 积分更新（真正的状态演化）；
 *  · WebGPU 没有 gl_PointSize 等价物，point-list 只能绘制 1px 点，
 *    因此每个粒子以 6 顶点的实例化 quad 做 billboard 绘制（配合 camRight/camUp）。
 *
 * # 运动模型
 * 每个粒子先算出一个「归宿位置」target，再由弹簧 + 速度阻尼趋近它，叠加噪声流场、
 * 低频呼吸、节拍径向冲量、涟漪位移与预设切换爆散。弹簧结构天然给出
 * 「被推出去 → 平滑回落」的曲线，因此任何切换都不会出现折线或瞬移。
 *
 * target 的来源分三种：
 *  1. `kind = star`：星河背景层，大尺度缓慢漂移壳层，与预设完全无关；
 *  2. `preset = 0`（专辑封面）：在「星云球面」与「封面平面」之间按 coverMix 连续插值；
 *  3. `preset = 1..12`：由 `presetTarget()` 给出的专属几何。
 *
 * # 为什么用 createXxxPipelineAsync 而不是同步版本
 * WGSL 编译错误是**异步**上报的：同步 `createComputePipeline()` 不会抛异常，
 * 只会产出一个坏管线，表现为「打开了粒子界面但是全黑」。用 async 版本 +
 * `getCompilationInfo()` 显式校验，失败即抛错，上层工厂随即可降级到 WebGL 2.0。
 *
 * 两条路径共用同一套音频特征、预设语义与镜头状态，保证视觉与交互一致。
 *
 * 许可证：本文件为独立实现。预设清单参考 Mineradio（GPL-3.0）的视觉目录，
 * 但全部几何、配色与过渡曲线均为自行设计与推导，未复制其源码，不引入 copyleft 传染。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three'
import { COVER_TEXTURE_SIZE, createPlaceholderCover } from './cover-texture'
import { BASE_FOV, DEFAULT_FX, verticalFovForAspect } from './types'
import type {
  AudioFeatures,
  CameraState,
  FxSettings,
  ParticleRenderer,
  ParticleRendererOptions,
} from './types'

type Any = any

/**
 * 每个粒子 16 个 float（64 字节）：
 *   pos.xyz + seed | vel.xyz + scale | uv.xy + kind + pad | anchor.xyz + pad
 * 分组为 4 组 `vec3 + f32`，每组 16 字节，满足 WGSL 的对齐要求。
 *
 * `anchor` 是固定的初始锚点。上一版直接用 `normalize(p.pos)` 当锚点，弹簧指向会随粒子
 * 自身位置漂移，无法支持「在两种形态之间插值」——必须有不变的目标基准。
 * `kind` 区分普通粒子与星河粒子，让「星河」无需第二条管线即可与预设完全隔离。
 */
const FLOATS_PER_PARTICLE = 16

/** 涟漪寿命，必须与 beat.ts 的 RIPPLE_LIFE 一致。 */
const RIPPLE_LIFE = 2.0


/**
 * 封面平面边长：直接对齐 Mineradio 的 PLANE_SIZE = 4.8，与 webgl2.ts 保持一致。
 * 这个尺度与涟漪半径、各预设的绝对坐标常量、相机基线半径、FOV 是一整套耦合参数，
 * 单独改任何一个都会让涟漪只覆盖中心一小块、或让粒子跑出取景框。
 */
const DEFAULT_PLANE = 4.8

/** 星河背景层粒子数缺省值（与 Mineradio 的量级一致）。 */
const DEFAULT_STAR_COUNT = 1400

/**
 * WebGPU buffer usage 位标志。
 *
 * 这里不直接引用全局 `GPUBufferUsage`，因为那是 `@webgpu/types` 提供的声明，
 * 本项目根目录与 frontend 都没有引入该包（且本文件同时被两个 TS 工程编译），
 * 直接引用会导致 TS2304。数值来自 WebGPU 规范，写成常量可保持零新增依赖。
 */
const BUFFER_USAGE = {
  COPY_DST: 0x0008,
  STORAGE: 0x0080,
  UNIFORM: 0x0040,
  COPY_SRC: 0x0004,
  MAP_READ: 0x0001,
} as const

/**
 * WebGPU **texture** usage 位标志。
 *
 * ⚠ 这是一套与 GPUBufferUsage **数值完全不同**的枚举，绝不能混用：
 *   GPUTextureUsage.COPY_SRC = 0x01 / COPY_DST = 0x02 / TEXTURE_BINDING = 0x04
 *   / STORAGE_BINDING = 0x08 / RENDER_ATTACHMENT = 0x10
 * 而 GPUBufferUsage 的 COPY_DST 是 0x0008、COPY_SRC 是 0x0004。
 *
 * 历史坑（2026-09-15 修复）：本文件早期用上面的 BUFFER_USAGE 去建纹理，
 * 于是「COPY_DST」被建成了 0x0008（= STORAGE_BINDING），真正的 COPY_DST(0x02) 缺失。
 * `copyExternalImageToTexture` 要求纹理同时具备 COPY_DST 与 RENDER_ATTACHMENT，
 * 校验不通过时**不抛异常**、只在 uncaptured error 里上报，纹理保持全 0 ——
 * 表现为「WebGPU 初始化成功、粒子也在动、但专辑封面完全没有内容」，且日志里
 * 看不到任何报错（try/catch 抓不到异步校验错误），极难定位。
 */
const TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10,
} as const

/** GPUMapMode.READ：纹理回读（诊断用）映射模式。 */
const GPU_MAP_READ = 0x0001

/**
 * Uniform 布局（Float32Array 索引，严格 16 字节对齐）。
 * 与下方 WGSL 的 `struct Uniforms` 字段顺序必须逐项对应；
 * 静态校验脚本会按 WGSL 对齐规则重算偏移并与本表逐项比对。
 */
const U = {
  viewProj: 0, // mat4x4 占 0..15
  camRight: 16, // vec3 占 16..18
  time: 19,
  camUp: 20, // vec3 占 20..22
  dt: 23,
  bass: 24,
  mid: 25,
  treble: 26,
  energy: 27,
  pulse: 28,
  radius: 29,
  pointSize: 30,
  coverMix: 31,
  plane: 32,
  hasCover: 33,
  coverLum: 34,
  preset: 35,
  ripples: 36, // array<vec4,4> 占 36..51
  count: 52,
  presetBurst: 53,
  tanHalfFov: 54,
  viewportHeightPx: 55,
  intensity: 56,
  speed: 57,
  depth: 58,
  twist: 59,
  scatter: 60,
  bloom: 61,
  edge: 62,
  bgFade: 63,
  // ---- 实验调参（2026-09-15 扩容：把着色器硬编码常数提升为 uniform）----
  spectrumAmp: 64,
  flowBase: 65,
  flowBass: 66,
  flowMid: 67,
  rippleAmp: 68,
  rippleBright: 69,
  pulseBase: 70,
  pulseBass: 71,
  burstAmp: 72,
  reliefAmp: 73,
  sizeBase: 74,
  sizeMax: 75,
  brightBase: 76,
  alphaBase: 77,
} as const

// 78 个 float 会被 WGSL 按 16 字节对齐补齐到 80（320 字节），与 struct Uniforms 的
// 实际大小保持一致（静态校验脚本会比对二者，不一致会报错）。
const UNIFORM_FLOATS = 80

const WGSL = /* wgsl */ `
struct Particle {
  pos: vec3<f32>,
  seed: f32,
  vel: vec3<f32>,
  scale: f32,
  uv: vec2<f32>,
  kind: f32,
  pad1: f32,
  anchor: vec3<f32>,
  pad2: f32,
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
  pulse: f32,
  radius: f32,
  pointSize: f32,
  coverMix: f32,
  plane: f32,
  hasCover: f32,
  coverLum: f32,
  preset: f32,
  ripples: array<vec4<f32>, 4>,
  count: u32,
  presetBurst: f32,
  // 把 Mineradio 的「像素点大小」换算成世界尺寸所需的两项参数
  // （占用原本的 padC/padD，不改变结构体大小与既有偏移）
  tanHalfFov: f32,
  viewportHeightPx: f32,
  // ---- 动效参数（对应 Mineradio 的 fx 滑块，2026-09-14 扩容）----
  intensity: f32,
  speed: f32,
  depth: f32,
  twist: f32,
  scatter: f32,
  bloom: f32,
  edge: f32,
  bgFade: f32,
  // ---- 实验调参（2026-09-15 扩容）----
  // 原先这些是散落在着色器里的字面量，无法实时调节；现统一提升为 uniform，
  // 默认值 = 原字面量，因此不改变默认观感。顺序须与 JS 侧 U 表逐项对应。
  spectrumAmp: f32,
  flowBase: f32,
  flowBass: f32,
  flowMid: f32,
  rippleAmp: f32,
  rippleBright: f32,
  pulseBase: f32,
  pulseBass: f32,
  burstAmp: f32,
  reliefAmp: f32,
  sizeBase: f32,
  sizeMax: f32,
  brightBase: f32,
  alphaBase: f32,
};

const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 6.283185307179586;

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

// 单枚涟漪的位移贡献：中心高斯鼓包 + 向外扩张的高斯环。
// r = vec4(age, strength, x, y)；strength<=0 或 age<0 表示槽位空闲。
// 半径是「世界单位」绝对值，与 Mineradio 一致 —— 它只在 PLANE_SIZE = 4.8
// 这个尺度下才覆盖到平面宽度的三成，所以平面尺度不能单独改。
fn rippleAt(p: vec2<f32>, r: vec4<f32>) -> f32 {
  let age = r.x;
  let strength = r.y;
  if (strength <= 0.0 || age < 0.0) { return 0.0; }
  let life = age / ${RIPPLE_LIFE.toFixed(1)};
  let env = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.62, 1.0, life));
  let dist = length(p - r.zw);
  let bulgeW = 0.55 + age * 0.80;
  let bulge = exp(-(dist * dist) / (2.0 * bulgeW * bulgeW))
            * (1.0 - smoothstep(0.0, 0.55, life));
  let ringR = age * 2.10;
  let ringW = 0.40 + age * 0.22;
  let ring = exp(-pow((dist - ringR) / ringW, 2.0));
  return (bulge * 2.40 + ring * 1.30) * env * strength;
}

// 固定长度数组用常量下标访问：这里手工展开，不做循环
fn rippleSum(p: vec2<f32>, u: Uniforms) -> f32 {
  return rippleAt(p, u.ripples[0])
       + rippleAt(p, u.ripples[1])
       + rippleAt(p, u.ripples[2])
       + rippleAt(p, u.ripples[3]);
}

/**
 * 13 种预设各自的「归宿几何」。
 *
 * 全部写成 (uv, seed, anchor, time, 音频) 的纯函数，因此在 compute 路径里是弹簧的目标，
 * 在 WebGL 顶点路径里可以直接求值 —— 两条后端共用同一套形状定义，观感因此一致。
 *
 * 统一平面坐标：c = uv 映射到以原点为中心的方形，r = |c|，ang = atan2(c.y, c.x)。
 * 上游构造网格时 uv 取 texel 中心，不会踩到 0/1 边界。
 */
fn hash11(p: f32) -> f32 {
  return fract(sin(p * 127.1) * 43758.5453123);
}

/**
 * 13 种预设的归宿位置 —— 逐式对齐 Mineradio 顶点着色器的原文。
 *
 * 上一版是按它的思路近似重写的（常数、曲线、结构都不同）；这里直接采用其原式：
 * 每个预设的「几何 + 音频位移」全部在本函数内一次算完（与它把位移写进 pos 的做法一致），
 * 涟漪 Z 与预设切换爆散仍由调用方叠加。
 *
 * 只读模块级 uniform，因此签名很短；本函数仅在 compute 阶段被调用。
 * K = uIntensity(0.85) × 1.6 = 1.36，即 Mineradio 的默认强度。
 * 省略项：依赖其 AI 深度/边缘纹理的 depthZ / edgeBoost（本项目无该纹理），
 * 以及依赖 uCoverRes 的 hiResGuard（无对应设置，等价于取 1）。
 */
fn presetTarget(uv: vec2<f32>, seed: f32, anchor: vec3<f32>) -> vec3<f32> {
  // 律动强度：K = intensity * 1.6（其 uIntensity 默认 0.85 → 1.36）
  let K = u.intensity * 1.6;
  let t = u.time * u.speed;
  let s = u.preset;
  let plane = u.plane;
  // 其平面坐标由 gx/(grid-1) 生成，等价于 (aUv - 0.5) * PLANE_SIZE
  let c = vec2<f32>((uv.x - 0.5) * plane, (uv.y - 0.5) * plane);

  // 0 SILK：平面 + 中/高/低频驱动的 Z 起伏（midN / midMask / trebleJ / bassBreath 原式）
  // 静息时冻结时间，避免封面自转或起伏
  var st = t;
  if (s < 0.5 && u.bass == 0.0 && u.mid == 0.0 && u.treble == 0.0) {
    st = 0.0;
  }
  if (s < 0.5) {
    let midN = snoise(vec3<f32>(c.x * 1.4, c.y * 1.4, st * 0.55)) * 0.6
             + snoise(vec3<f32>(c.x * 2.8 + 5.0, c.y * 2.8 - 3.0, st * 0.85)) * 0.4;
    let midMask = 0.55 + 0.45 * snoise(vec3<f32>(c.x * 0.4, c.y * 0.4, st * 0.18));
    let midDisp = midN * u.mid * 0.55 * midMask * K;
    let trebleJ = snoise(vec3<f32>(c.x * 6.5, c.y * 6.5, t * 3.5 + seed * 4.0))
                * u.treble * 0.18 * K;
    let bassBreath = snoise(vec3<f32>(c.x * 0.35, c.y * 0.35, t * 0.4)) * u.bass * 0.42 * K;
    // 深度/边缘纹理：R=depth → 浮雕位移（原式 depthZ）
    let depthZ = (textureSampleLevel(u_edgeTex, u_coverSampler,
      clamp(uv, vec2<f32>(0.0022), vec2<f32>(0.9978)), 0.0).r - 0.5)
      * u.depth * 1.40;
    return vec3<f32>(c.x, c.y, midDisp + trebleJ + bassBreath + depthZ);
  }

  // 1 TUNNEL：筒壁 + 沿轴流动；bass 让筒径「收缩」（注意是负号）（移除了整管自旋）
  if (s < 1.5) {
    let angle = uv.x * 6.283185307179586;
    let flow = fract(uv.y - t * 0.08 * (1.0 + u.bass * 0.55));
    let zPos = (flow - 0.5) * 9.0;
    let baseR = 2.0 - u.bass * 0.28 * K;
    let ripG = sin(angle * 5.0 + zPos * 1.4 + t * 2.2) * 0.10 * (u.mid + u.treble) * K;
    let r = baseR + ripG;
    return vec3<f32>(cos(angle) * r, sin(angle) * r, zPos);
  }

  // 2 ORBIT：球面（无扁率、无环）+ treble 起毛刺、bass 整体膨胀（移除了 yaw 自转）
  if (s < 2.5) {
    let theta = uv.x * 6.283185307179586;
    let phi = (uv.y - 0.5) * 3.141592653589793;
    let trebFlare = snoise(vec3<f32>(theta * 1.5, phi * 1.5, t * 0.7)) * u.treble * 0.85 * K;
    let bassExpand = u.bass * 0.35 * K;
    let r = 2.2 * (1.0 + bassExpand) + trebFlare;
    return vec3<f32>(r * cos(phi) * cos(theta), r * sin(phi), r * cos(phi) * sin(theta));
  }

  // 3 VOID：无粒子 —— 几何推到远处，渲染阶段把 alpha 压 0（其原式即 vAlpha = 0）
  if (s < 3.5) {
    return vec3<f32>(c.x * 0.01, c.y * 0.01, -90.0);
  }

  // 4 VINYL RECORD：中心封面 + 黑胶沟槽 + 完整白边 + 盘面自转（对齐 Mineradio uVinylSpin）
  if (s < 4.5) {
    let spin = u.time * u.speed * 0.15; // 持续缓慢旋转，对齐 Mineradio 的 uVinylSpin
    let cs = cos(spin);
    let sn = sin(spin);
    let p = (uv - vec2<f32>(0.5, 0.5)) * 5.12;
    // 应用旋转变换
    let rp = vec2<f32>(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
    let d = length(rp);
    let recordR = 2.46;
    let coverR = 1.18;
    let bassDrive = smoothstep(0.08, 0.78, u.bass + u.pulse * 0.82);
    let highDrive = smoothstep(0.05, 0.46, u.treble);
    let border = exp(-pow((d - coverR) / 0.064, 2.0));
    let vinylN = clamp((d - coverR) / max(0.001, recordR - coverR), 0.0, 1.0);
    let angle0 = atan2(rp.y, rp.x);
    let groove = 0.5 + 0.5 * sin((d - coverR) * 98.0);
    let tickHash = hash11(floor((angle0 + 3.141592653589793) * 38.0) + floor(d * 72.0) * 2.1);
    let tick = smoothstep(0.82, 0.995, tickHash);
    // 中心封面区 / 黑胶沟槽区的 Z 是两套公式（原式的 if/else）
    let zCover = 0.040 + border * 0.026 + u.pulse * 0.018;
    let zVinyl = groove * 0.010 + border * 0.024
               + bassDrive * vinylN * 0.016 * K + tick * highDrive * 0.010;
    let inside = 1.0 - smoothstep(coverR - 0.012, coverR + 0.018, d);
    let radial = 1.0 + bassDrive * 0.012 + u.pulse * 0.026;
    return vec3<f32>(rp.x * radial, rp.y * radial, select(zVinyl, zCover, inside > 0.02));
  }

  // 6 安魂（骷髅点云）：坐标来自外部点云资源（setSkullPoints 写入 anchor 字段），
  //   对齐 Mineradio 的 float-skull-backcover.js：整体旋转 + 微弱漂移，无拉伸缩放
  //   【关键：必须有 return，否则会继续落入下方 s<8.5 WALLPAPER PULSE 分支变成"矩阵"】
  if (s > 5.5 && s < 6.5) {
    // 整体旋转（对齐 Mineradio 的 orbit 逻辑）
    let orbit = t * 0.03;
    let cs = cos(orbit);
    let sn = sin(orbit);
    let rx = cs * anchor.x - sn * anchor.y;
    let ry = sn * anchor.x + cs * anchor.y;
    // 微弱漂移（对齐 Mineradio 的 aAmp * 0.34 等）
    let driftX = sin(t * 0.18 + p.seed * 6.28) * 0.04;
    let driftY = cos(t * 0.15 + p.seed * 6.28) * 0.035;
    let driftZ = sin(t * 0.11 + p.seed * 6.28) * 0.06;
    return vec3<f32>(rx + driftX, ry + driftY, anchor.z + driftZ);
  }

  // 5-8 WALLPAPER PULSE：螺旋极光带（lane<0.80）+ 远景尘埃（lane>=0.80）+ 切换脉冲
  if (s < 8.5) {
    let lane = uv.y;
    var pos: vec3<f32>;
    if (lane < 0.80) {
      let laneWarp = snoise(vec3<f32>(uv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11
                   + (hash11(seed * 73.1) - 0.5) * 0.045;
      let warpedLane = clamp(lane + laneWarp, 0.0, 0.80);
      let bandCoord = warpedLane / 0.80 * 5.65
                    + snoise(vec3<f32>(uv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;
      let band = floor(bandCoord);
      let local = fract(bandCoord + hash11(band * 9.13 + seed * 2.4) * 0.18);
      let bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);
      let bseed = hash11(band * 19.17 + seed * 31.0);
      let flow = fract(uv.x + t * (0.0034 + bandN * 0.0038 + bseed * 0.0022) + bseed * 0.53);
      let arc = (flow - 0.5) * 3.141592653589793 * (1.35 + bandN * 0.72 + bseed * 0.24);
      let armCurve = sin(arc + bandN * 2.2 + bseed * 5.3);
      let spiralRadius = 9.2 + bandN * 11.8 + bseed * 6.0 + local * 2.9;
      let x = cos(arc * 0.72 + bandN * 0.92 + bseed * 1.3) * spiralRadius
            + (flow - 0.5) * (13.5 + bandN * 9.5);
      let ribbonPhase = flow * 6.283185307179586 * (0.55 + bandN * 0.24 + bseed * 0.10)
                      + t * (0.010 + bandN * 0.007) + bseed * 5.7;
      let broadWave = sin(ribbonPhase) * 0.92;
      let fineWave = sin(ribbonPhase * (1.36 + bseed * 0.62) - t * 0.044 + bseed * 5.0) * 0.045;
      let yBase = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6)
                + (bseed - 0.5) * 1.85
                + snoise(vec3<f32>(bandN * 2.0, flow * 0.62, bseed)) * 0.92;
      let ridgeCenter = 0.43 + (bseed - 0.5) * 0.18;
      let ridge = exp(-pow((local - ridgeCenter) / (0.25 + bseed * 0.04), 2.0));
      let ribbonNoise = snoise(vec3<f32>(flow * 1.18 + bseed, bandN * 2.0, t * 0.018)) * 0.74;
      let zLayer = mix(-23.5, 15.5, bandN) + (bseed - 0.5) * 6.0;
      pos = vec3<f32>(
        x + ribbonNoise * 1.40 + sin(t * 0.012 + bseed * 8.0) * 0.22,
        yBase + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14),
        zLayer + broadWave * 1.35 + ribbonNoise * 1.85
      );
    } else {
      let q = (lane - 0.80) / 0.20;
      let dseed = hash11(seed * 917.0 + floor(q * 130.0));
      let depth = mix(-32.0, 18.0, dseed);
      let drift = fract(uv.x + t * (0.0014 + dseed * 0.0048) + dseed * 0.63);
      let cluster = snoise(vec3<f32>(dseed * 2.0, q * 3.2, t * 0.007));
      let x = (drift - 0.5) * (45.0 + dseed * 22.0) + cluster * 3.4;
      let y = (hash11(seed * 331.0 + dseed * 5.0) - 0.5) * 22.0
            + sin(t * (0.018 + dseed * 0.028) + dseed * 7.0) * 0.86;
      let z = depth + sin(t * (0.020 + dseed * 0.032) + seed * 8.0) * 1.05;
      pos = vec3<f32>(x, y, z);
    }
    let transition = clamp(u.presetBurst, 0.0, 1.0);
    if (transition > 0.001) {
      let bloom = smoothstep(0.0, 1.0, transition);
      let bv = pos.xy + vec2<f32>(hash11(seed * 31.0) - 0.5, hash11(seed * 47.0) - 0.5) * 0.75;
      let bdir = bv / max(length(bv), 0.001);
      let nx = snoise(vec3<f32>(seed, t * 0.014, 1.0));
      let ny = snoise(vec3<f32>(seed, t * 0.014, 5.0));
      let grow = 1.0 + bloom * 0.014;
      pos = vec3<f32>(
        (pos.x + bdir.x * bloom * 0.026 + nx * bloom * 0.06) * grow,
        (pos.y + bdir.y * bloom * 0.026 + ny * bloom * 0.06) * grow,
        pos.z + (hash11(seed * 123.0) - 0.5) * bloom * 0.18
      );
    }
    return pos;
  }

  // 9 ECLIPSE HALO：8 层倾斜椭圆环 + 日冕
  if (s < 9.5) {
    let ringIndex = floor(uv.y * 8.0);
    let ringLocal = fract(uv.y * 8.0);
    let ringN = (ringIndex + 0.5) / 8.0;
    let ringSeed = hash11(ringIndex * 19.73 + 2.1);
    let theta = uv.x * 6.283185307179586 + ringIndex * 0.47 + t * (0.035 + ringN * 0.026);
    let eclipseDrive = smoothstep(0.06, 0.76, u.bass) * 0.17 + u.pulse * 0.08;
    let radius = 0.92 + ringN * 3.18 + (ringLocal - 0.5) * 0.24
               + eclipseDrive * (0.18 + ringN * 0.34);
    let eccentric = 0.49 + ringN * 0.20;
    let xh = cos(theta) * radius * (1.18 + ringN * 0.10);
    let yh = sin(theta) * radius * eccentric;
    let zh = (ringN - 0.5) * 1.34 + sin(theta * 2.0 + ringSeed * 6.0) * (0.10 + ringN * 0.09);
    let tilt = -0.34 + ringN * 0.72;
    let ct = cos(tilt);
    let st = sin(tilt);
    return vec3<f32>(xh, yh * ct - zh * st, yh * st + zh * ct);
  }

  // 10 NEON DRIZZLE：52 条雨列 + 城市纵深 + 透视缩放 + 风偏
  if (s < 10.5) {
    let column = floor(uv.x * 52.0);
    let columnN = (column + 0.5) / 52.0;
    let columnLocal = fract(uv.x * 52.0);
    let rainSeed = hash11(column * 41.17 + floor(columnLocal * 5.0) * 7.9);
    let rainSpeed = 0.026 + rainSeed * 0.052 + smoothstep(0.08, 0.76, u.bass) * 0.014;
    let fall = fract(1.0 - uv.y + t * rainSpeed + rainSeed * 0.87);
    let xRain = (columnN - 0.5) * 11.8 + (columnLocal - 0.5) * 0.11;
    let yRain = (0.5 - fall) * 8.8;
    let cityDepth = mix(-3.8, 2.6, hash11(column * 11.3 + 0.7));
    let wind = sin(t * 0.17 + column * 0.63 + fall * 3.4) * (0.08 + rainSeed * 0.12);
    let perspective = 0.76 + smoothstep(-3.8, 2.6, cityDepth) * 0.34;
    return vec3<f32>((xRain + wind) * perspective, yRain,
                     cityDepth + sin(fall * 6.283185307179586 + rainSeed * 7.0) * 0.05);
  }

  // 11 PRISM FLOCK：12 群「翼 + 身」形状，振翅由 mid / beat 驱动
  if (s < 11.5) {
    let flockIndex = floor(uv.y * 12.0);
    let wingY = fract(uv.y * 12.0) * 2.0 - 1.0;
    let wingX = uv.x * 2.0 - 1.0;
    let flockSeed = hash11(flockIndex * 23.73 + 4.0);
    let gx = (flockIndex - floor(flockIndex / 4.0) * 4.0) - 1.5;
    let gy = floor(flockIndex / 4.0) - 1.0;
    let migrate = t * (0.018 + flockSeed * 0.018);
    let centerX = gx * 2.42 + sin(migrate + flockSeed * 8.0) * 0.48;
    let centerY = gy * 2.10 + cos(migrate * 0.83 + flockSeed * 9.0) * 0.36;
    let ax = abs(wingX);
    let flap = sin(t * (0.72 + flockSeed * 0.35) + flockIndex * 1.7)
             * (0.34 + u.mid * 0.42 + u.pulse * 0.16);
    let lx = sign(wingX) * (0.12 + pow(ax, 0.76) * 0.88);
    let ly = wingY * (0.48 + (1.0 - ax) * 0.22);
    let lz = ax * (0.42 + flap) + (1.0 - abs(wingY)) * 0.08;
    let heading = -0.20 + (flockSeed - 0.5) * 0.70;
    let ch = cos(heading);
    let sh = sin(heading);
    return vec3<f32>(centerX + ch * lx - sh * ly,
                     centerY + sh * lx + ch * ly,
                     (flockSeed - 0.5) * 3.4 + lz);
  }

  // 12 ABYSSAL BLOOM：9 瓣放射 + 碗形纵深 + 花瓣波
  let bloomR = pow(max(uv.y, 0.0), 0.72);
  let bloomTheta = uv.x * 6.283185307179586 + bloomR * 0.72 + t * 0.018;
  let petalWave = 0.5 + 0.5 * cos(bloomTheta * 9.0 - bloomR * 3.8);
  let bloomDrive = smoothstep(0.06, 0.74, u.bass) * 0.26 + u.pulse * 0.10;
  let radiusBloom = bloomR * (3.30 + bloomDrive) * (0.78 + petalWave * 0.34);
  let petalFold = sin(bloomTheta * 9.0 - bloomR * 5.4 + t * 0.13);
  let bowl = (1.0 - bloomR) * 1.12 - bloomR * bloomR * 0.52;
  let bx = cos(bloomTheta) * radiusBloom;
  let by = sin(bloomTheta) * radiusBloom * 0.82;
  let bz = bowl + petalFold * (0.13 + bloomR * 0.47)
         + sin(bloomTheta * 3.0 + t * 0.07) * 0.08;
  let bloomTilt = -0.30;
  let cb = cos(bloomTilt);
  let sb = sin(bloomTilt);
  return vec3<f32>(bx, by * cb - bz * sb, by * sb + bz * cb);
}

/** 星河背景层：大尺度壳层 + 极缓慢噪声形变，与预设完全无关。 */
fn starTarget(anchor: vec3<f32>, seed: f32, t: f32, plane: f32) -> vec3<f32> {
  let dir = normalize(anchor + vec3<f32>(1e-4));
  let rad = plane * (0.85 + seed * 1.35);
  let drift = flowField(dir * 2.2 + vec3<f32>(0.0, 0.0, t * 0.05), t * 0.35);
  return dir * rad + drift * 0.10;
}

/**
 * 每个预设的基础粒子色 —— 直接采用 Mineradio 的配色数据（defaultColor 与各预设专属色）。
 *
 * 上一版用本项目自己的「香槟金 ↔ 薄荷绿」双色插值，但这两色亮度偏高，叠加加法混合后
 * 「粒子围住相机」的预设会整屏刷白（滚筒实测均值 240/255）。Mineradio 的基色整体更暗，
 * 且 5~12 号预设各有专属极光 / 霓虹 / 棱镜调色板 —— 这些是其视觉身份，按需求一并对齐。
 */
fn presetPalette(preset: f32, uv: vec2<f32>, seed: f32, bass: f32) -> vec3<f32> {
  let colA = vec3<f32>(0.968, 0.905, 0.807);
  let colB = vec3<f32>(0.658, 0.902, 0.811);
  let s = preset;

  // 0 专辑封面：底色用品牌双色（封面本身会覆盖它）
  if (s < 0.5) {
    return mix(colA, colB, clamp(seed, 0.0, 1.0));
  }
  // 1-4（滚筒 / 星球 / 虚空 / 唱片）：defaultColor —— 紫 → 粉/蓝渐变
  if (s < 4.5) {
    return mix(
      vec3<f32>(0.36, 0.28, 0.72),
      mix(vec3<f32>(0.85, 0.55, 0.95), vec3<f32>(0.45, 0.78, 0.95), uv.x),
      uv.y
    );
  }
  // 5-8 音域回响：极光带（青 → 紫）
  if (s < 8.5) {
    let aurora = mix(vec3<f32>(0.52, 0.86, 1.00), vec3<f32>(0.70, 0.58, 1.00), uv.y);
    return mix(aurora, vec3<f32>(0.96, 0.98, 0.92), smoothstep(0.07, 0.78, bass) * 0.05);
  }
  // 9 月蚀圣杯：冷缘 → 古金，按环序过渡
  if (s < 9.5) {
    return mix(vec3<f32>(0.48, 0.82, 1.00), vec3<f32>(0.93, 0.72, 0.38),
               smoothstep(0.18, 0.84, uv.y + sin(uv.x * 6.2831) * 0.08));
  }
  // 10 雨幕霓虹：青 → 洋红 → 琥珀，按列随机选色
  if (s < 10.5) {
    let rain = mix(vec3<f32>(0.20, 0.88, 1.00), vec3<f32>(1.00, 0.26, 0.63),
                   smoothstep(0.18, 0.78, seed));
    return mix(rain, vec3<f32>(1.00, 0.72, 0.30), smoothstep(0.84, 0.99, seed));
  }
  // 11 折光蝶群：青绿 → 品红，边缘转金
  if (s < 11.5) {
    let prism = mix(vec3<f32>(0.42, 0.94, 0.82), vec3<f32>(0.96, 0.62, 0.92),
                    smoothstep(-0.8, 0.8, uv.x * 2.0 - 1.0));
    return mix(prism, vec3<f32>(1.00, 0.91, 0.64),
               smoothstep(0.72, 1.0, abs(uv.x * 2.0 - 1.0)));
  }
  // 12 深海绽放：深海绿 → 紫罗兰，外缘转珠白
  let r = pow(max(uv.y, 0.0), 0.72);
  let bloom = mix(vec3<f32>(0.12, 0.58, 0.56), vec3<f32>(0.38, 0.32, 0.95),
                  smoothstep(0.18, 0.88, r));
  return mix(bloom, vec3<f32>(0.82, 1.00, 0.94), smoothstep(0.64, 0.98, r) * 0.55);
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> u: Uniforms;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.count) { return; }

  var p = particles[i];
  let isStar = p.kind > 0.5;

  // ---- 归宿位置 ----（tgt 避开 WGSL 保留字 target，否则 WebGPU 编译失败降级 WebGL）
  var tgt: vec3<f32>;
  var flowScale: f32;
  var burstScale: f32;
  if (isStar) {
    tgt = starTarget(p.anchor, p.seed, u.time, u.plane);
    flowScale = 1.0;
    burstScale = 0.0; // 星河不参与预设切换爆散
  } else if (u.preset < 0.5) {
    // 专辑封面：星云球面 ↔ 封面平面连续插值。没有封面时上层会把 coverMix 压到 0，
    // 于是自然退化为星云形态，不会出现「粒子堆在一块没有图像的平面上」
    let m = clamp(u.coverMix, 0.0, 1.0) * u.hasCover;
    let planeTarget = vec3<f32>((p.uv.x - 0.5) * u.plane, (0.5 - p.uv.y) * u.plane, 0.0);
    // 星云端直接用原始锚点 —— 与 webgl2 的 mix(position, planePos, m) 完全一致
    // （webgl2 的 position 就是初始球面属性，等价于此处的 p.anchor）。
    // 早期版本写成 normalize(anchor) * radius*(0.55+seed*0.45)，会重排粒子径向分布，
    // 与 WebGL 的星云形态对不上。
    // 注意：WGSL 在 TS 模板字符串里，注释中禁止出现反引号，否则提前闭合字符串报 TS1005。
    let cloudTarget = p.anchor;
    tgt = mix(cloudTarget, planeTarget, m);
    flowScale = mix(1.0, 0.30, m); // 封面形态下减弱流动，否则图像会被抹糊
    burstScale = mix(1.0, 0.55, m);
  } else {
    // 逐式对齐 Mineradio 后，预设自身已含完整几何与音频位移；
    // 其原式没有流场，这里只保留很轻的一层以免丢掉「流体感」
    tgt = presetTarget(p.uv, p.seed, p.anchor);
    flowScale = 0.25;
    burstScale = 1.0;
  }

  // ---- 与 webgl2 对齐：归宿位置 + 各项「位移」（不是加速度）----
  // 本文件最易踩的坑：webgl2 是**无状态**模型，顶点着色器里
  //   p = base + flow*flowAmp + ripple*1.30 + dir*pulse*(0.45+bass*0.90) + dir*burst*1.60
  // 各项都是**位移**，量级只有 0.55~2.8，天然有界。
  // 本文件是**有状态弹簧积分**，早期版本把上述「位移」当成「加速度」写进 acc
  // （flow 5~20 / pulse 46 / burst 120 / ripple 30），经速度二次积分、阻尼仅 0.9 后
  // 稳态偏移 ≈ 加速度 / 2.6 —— 爆散项可达 46 个单位，远超相机基线半径 6.6，
  // 粒子被甩出视野，表现为「出现一下就消失，与 WebGL 完全不一致」。
  // 现改为与 webgl2 同量级、同公式的**位移**；弹簧只负责平滑趋近，
  // 既保住切预设/切封面的连续过渡观感，目标又有界 → 不再发散。
  var base = tgt;
  // 粒子扭曲：绕视轴旋转（webgl2 :526-530 同式）
  if (u.twist > 0.0) {
    let tw = u.twist * (0.6 + base.z * 0.2);
    let cw = cos(tw);
    let sw = sin(tw);
    base = vec3<f32>(cw * base.x - sw * base.y, sw * base.x + cw * base.y, base.z);
  }
  // 离散感：沿径向随机外扩（webgl2 :532-534 同式，aRand ↔ p.seed）
  if (u.scatter > 0.0) {
    base = base + normalize(base + vec3<f32>(1e-4)) * (p.seed - 0.5) * u.scatter * 2.0;
  }
  let flow = flowField(base, u.time);
  // 位移系数改为 uniform（实验调参面板可实时改；默认 = webgl2 原字面量）
  let flowAmp = (u.flowBase + u.bass * u.flowBass + u.mid * u.flowMid) * flowScale;
  tgt = base + flow * flowAmp;
  // 封面形态 Z 浮雕（webgl2 的 relief，:552-561 同式）：
  // WGSL 的 presetTarget 里 s<0.5 分支从 compute 走不到（preset<0.5 走了封面分支），
  // 缺这一项会让默认封面预设比 WebGL 明显偏平 —— 这也是「与 WebGL 不一致」的一环。
  // 静息时冻结噪声相位，避免封面自转/起伏
  let mCover = clamp(u.coverMix, 0.0, 1.0) * u.hasCover;
  if (!isStar && u.preset < 0.5 && mCover > 0.001) {
    var staticT = u.time;
    if (u.bass == 0.0 && u.mid == 0.0 && u.treble == 0.0) {
      staticT = 0.0;
    }
    let n1 = snoise(vec3<f32>(base.xy * 1.4, staticT * 0.55));
    let n2 = snoise(vec3<f32>(base.xy * 2.8 + vec2<f32>(5.0), staticT * 0.85));
    let n3 = snoise(vec3<f32>(base.xy * 6.5, staticT * 3.5 + p.seed * 4.0));
    let breath = snoise(vec3<f32>(base.xy * 0.35, staticT * 0.40));
    let relief = (n1 * 0.60 + n2 * 0.40) * u.mid * 1.15
               + n3 * u.treble * 0.50 + breath * u.bass * 1.25;
    tgt = tgt + vec3<f32>(0.0, 0.0, relief * mCover * u.reliefAmp);
  }
  // 涟漪抬升：对齐 Mineradio，涟漪只对专辑封面（preset 0）生效
  // 其他预设（滚筒/星球/虚空/唱片/音域回响等）不受涟漪影响
  // ⚠️ 星河背景粒子（isStar=true）完全不参与涟漪计算
  if (!isStar && u.preset < 0.5) {
    tgt = tgt + vec3<f32>(0.0, 0.0, rippleSum(base.xy, u) * u.rippleAmp);
  }
  let dir = normalize(base + vec3<f32>(1e-4));
  // 节拍跳动 + 预设切换爆散
  tgt = tgt + dir * smoothstep(0.0, 1.0, u.pulse) * (u.pulseBase + u.bass * u.pulseBass) * burstScale;
  tgt = tgt + dir * smoothstep(0.0, 1.0, u.presetBurst) * u.burstAmp * burstScale;

  // ---- 直接落位（与 webgl2 的无状态模型逐项对齐）----
  // webgl2 是**无状态**的：顶点着色器每帧由 aUv/aRand/position 直接算出最终位置，
  // 没有任何跨帧状态，因此「过渡平滑」完全由上层缓动的 coverMix / presetBurst 负责。
  // 本文件若继续用弹簧积分（哪怕目标算对了），也会自带惯性与滞后，
  // 切预设/切封面的观感必然与 webgl2 不同 —— 这正是「WebGPU 不像 / WebGL 最像」的根源。
  // 故这里改为**直接落位**：pos = tgt，与 webgl2 完全同构。
  p.pos = tgt;
  p.vel = vec3<f32>(0.0);
  particles[i] = p;
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) glow: f32,
  @location(3) alpha: f32,
  @location(4) ripple: f32,
};

@group(0) @binding(0) var<storage, read> ro_particles: array<Particle>;
@group(0) @binding(1) var<uniform> ro_u: Uniforms;
@group(0) @binding(2) var u_coverSampler: sampler;
@group(0) @binding(3) var u_coverTex: texture_2d<f32>;
@group(0) @binding(4) var u_edgeTex: texture_2d<f32>;

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

  let isStar = p.kind > 0.5;
  let isCover = ro_u.preset < 0.5;
  // 虚空预设（索引 3）：隐去全部预设粒子，只留星河背景（Mineradio 的 VOID 原始语义）
  let voidPreset = ro_u.preset > 2.5 && ro_u.preset < 3.5;
  let mUse = select(0.0, clamp(ro_u.coverMix, 0.0, 1.0) * ro_u.hasCover, isCover);
  let pulse = smoothstep(0.0, 1.0, ro_u.pulse);
  let rip = rippleSum(p.pos.xy, ro_u);
  // 深度/边缘纹理：G=edge → 发光边强度（原式 edgeBoost）
  let edgeBoost = textureSampleLevel(u_edgeTex, u_coverSampler,
    clamp(p.uv, vec2<f32>(0.0022), vec2<f32>(0.9978)), 0.0).g * ro_u.edge;

  // ---- 点大小：与 webgl2.ts 同源，采用 Mineradio 的 depthSize = 36/-z 与 1~5px 夹取 ----
  // 上一版用 300/-z、上限 40px（世界单位），sprite 面积差约 8 倍 —— 这是整屏发白的根因。
  // WebGPU 没有 gl_PointSize，必须把「像素直径」换算成世界尺寸：
  //   每像素对应的世界长度 = 2 · 视深 · tan(fov/2) / 视口像素高
  // （rip 已在上方声明，这里复用）
  let centerClip = ro_u.viewProj * vec4<f32>(p.pos, 1.0);
  let viewDist = max(0.5, centerClip.w);
  // 36.0 → ro_u.sizeBase（实验调参可实时改，默认仍是 36）
  let depthSize = ro_u.sizeBase / viewDist;
  var sz: f32;
  if (ro_u.preset > 8.5) {
    let authoredDrive = ro_u.bass * 0.10 + ro_u.mid * 0.08 + ro_u.treble * 0.12 + ro_u.pulse * 0.10;
    sz = clamp(depthSize * (0.98 + authoredDrive), 1.00, 4.85);
  } else if (ro_u.preset > 4.5) {
    let flowDrive = ro_u.bass * 0.070 + ro_u.mid * 0.046 + ro_u.treble * 0.060
                  + ro_u.presetBurst * 0.090 + ro_u.pulse * 0.055;
    sz = clamp(depthSize * (1.05 + flowDrive), 1.00, 5.45);
  } else if (ro_u.preset > 3.5) {
    let ringDrive = ro_u.bass * 0.30 + ro_u.mid * 0.18 + ro_u.treble * 0.22 + ro_u.pulse * 0.30;
    sz = clamp(depthSize * (0.90 + ringDrive * 0.62), 1.05, 3.90);
  } else {
    // audioBoost 在 Mineradio 里作用在尺寸上（涟漪/节拍让粒子变大），不是亮度
    let rippleSizeBoost = rip * ro_u.rippleBright * 0.7;
    let audioBoost = 1.0 + rippleSizeBoost + edgeBoost * 0.55 + ro_u.pulse * 0.30 + ro_u.presetBurst * 0.5;
    // 上限 4.95 → ro_u.sizeMax（实验调参可实时改）
    sz = clamp(depthSize * audioBoost, 1.05, ro_u.sizeMax);
  }
  // 星河层用另一套夹取范围
  let starSz = clamp(sz * 1.30, 0.75, 5.60);
  let pixelWorld = (2.0 * viewDist * ro_u.tanHalfFov) / max(1.0, ro_u.viewportHeightPx);
  // 0.5：本工程画的是以中心为原点的 2×2 全幅 quad，半边长需取一半
  let size = select(sz, starSz, isStar) * pixelWorld * 0.5;
  let world = p.pos + ro_u.camRight * (q.x * size) + ro_u.camUp * (q.y * size);

  var out: VSOut;
  out.pos = ro_u.viewProj * vec4<f32>(world, 1.0);
  out.uv = q;

  // ---- 颜色：按预设取 Mineradio 的调色板 ----
  let basePalette = presetPalette(ro_u.preset, p.uv, p.seed, ro_u.bass);

  // 封面预设：采样专辑图原色
  // 顶点阶段没有屏幕空间导数，必须用 textureSampleLevel（textureSample 仅限片元阶段）
  let cuv = clamp(p.uv, vec2<f32>(0.0022), vec2<f32>(0.9978));
  var coverCol = textureSampleLevel(u_coverTex, u_coverSampler, cuv, 0.0).rgb;
  // 暗封面自动提亮：否则整张专辑图会糊成一片近黑粒子，什么都读不出来
  coverCol = pow(max(coverCol, vec3<f32>(0.0)), vec3<f32>(0.88))
           * mix(1.45, 1.0, clamp(ro_u.coverLum, 0.0, 1.0));

  // ---- 预设 1（滚筒）：筒壁贴当前封面，uv.y 用流动后的 flow；并按纵深淡出（原式）----
  // ---- 预设 4（唱片）：中心贴封面 + 黑胶沟槽 + 完整白边（原式）----
  var bodyCol = select(basePalette, mix(basePalette, coverCol, mUse), isCover);
  if (!isStar && ro_u.preset > 0.5 && ro_u.preset < 1.5) {
    let flow1 = fract(p.uv.y - ro_u.time * 0.08 * (1.0 + ro_u.bass * 0.55));
    let tuv = clamp(vec2<f32>(p.uv.x, flow1), vec2<f32>(0.0022), vec2<f32>(0.9978));
    let tunnelCover = textureSampleLevel(u_coverTex, u_coverSampler, tuv, 0.0).rgb;
    let zPos1 = (flow1 - 0.5) * 9.0;
    bodyCol = mix(basePalette,
                  tunnelCover * (0.4 + smoothstep(-4.5, 4.5, zPos1) * 0.7),
                  ro_u.hasCover);
  } else if (!isStar && ro_u.preset > 3.5 && ro_u.preset < 4.5) {
    let p4 = (p.uv - vec2<f32>(0.5, 0.5)) * 5.12;
    let d4 = length(p4);
    let recordR4 = 2.46;
    let coverR4 = 1.18;
    let border4 = exp(-pow((d4 - coverR4) / 0.064, 2.0));
    let outerRim4 = exp(-pow((d4 - (recordR4 - 0.050)) / 0.055, 2.0));
    let vinylN4 = clamp((d4 - coverR4) / max(0.001, recordR4 - coverR4), 0.0, 1.0);
    let angle04 = atan2(p4.y, p4.x);
    // 沟槽上的高频「打点」：只有高音时才亮
    let tick4 = smoothstep(0.82, 0.995,
      hash11(floor((angle04 + 3.141592653589793) * 38.0) + floor(d4 * 72.0) * 2.1));
    let coverUv4 = p4 / (coverR4 * 2.0) + vec2<f32>(0.5, 0.5);
    let cc4 = textureSampleLevel(u_coverTex, u_coverSampler,
      clamp(coverUv4, vec2<f32>(0.0022), vec2<f32>(0.9978)), 0.0).rgb;
    if (1.0 - smoothstep(coverR4 - 0.012, coverR4 + 0.018, d4) > 0.02) {
      let coverShade = 1.02 + 0.10 * (1.0 - smoothstep(0.0, coverR4, d4));
      bodyCol = mix(bodyCol, mix(cc4 * coverShade, vec3<f32>(1.0), border4 * 0.54),
                    ro_u.hasCover);
    } else {
      let groove4 = 0.5 + 0.5 * sin((d4 - coverR4) * 98.0);
      let fineGroove4 = 0.5 + 0.5 * sin((d4 - coverR4) * 170.0 + p.seed * 3.0);
      var vinyl4 = vec3<f32>(0.052, 0.054, 0.058)
                 + vec3<f32>(0.052) * groove4 + vec3<f32>(0.026) * fineGroove4;
      vinyl4 = mix(vinyl4, cc4 * 0.32, 0.18 * (1.0 - vinylN4));
      let whiteRing4 = max(border4 * 0.92, outerRim4 * 0.26);
      var vinylCol = mix(vinyl4, vec3<f32>(0.92, 0.94, 0.94), whiteRing4);
      vinylCol = mix(vinylCol, vec3<f32>(1.0),
                     tick4 * smoothstep(0.05, 0.46, ro_u.treble) * (0.06 + border4 * 0.12));
      bodyCol = mix(bodyCol, vinylCol, ro_u.hasCover);
    }
  }

  // ---- 星河：冷白偏香槟 + 缓慢闪烁 ----
  let twinkle = 0.65 + 0.35 * sin(ro_u.time * (0.6 + p.seed * 2.4) + p.seed * 31.0);
  let starCol = mix(vec3<f32>(0.780, 0.860, 0.950), vec3<f32>(0.968, 0.905, 0.807), 0.45) * twinkle;

  out.color = select(bodyCol, starCol, isStar);

  // ---- 亮度：直接采用 Mineradio 的分组 vBright 公式 ----
  // 上一版自造的加权和峰值可达约 1.9，会把「粒子围住相机」的预设整屏刷白；
  // Mineradio 的区间只有 0.82~1.1、节拍项权重 0.016~0.16 —— 亮而不刺眼的关键。
  // 这里省掉了 edgeBoost 项：它依赖 Mineradio 的 AI 边缘/深度纹理，本项目没有。
  let maxRippleAmp = max(rip, 0.0);
  var vBright: f32;
  if (ro_u.preset > 8.5) {
    vBright = 0.86 + maxRippleAmp * 0.52 * ro_u.rippleBright + ro_u.energy * 0.045 + ro_u.pulse * 0.055;
  } else if (ro_u.preset > 4.5) {
    vBright = 0.94 + maxRippleAmp * 0.34 * ro_u.rippleBright + ro_u.bass * 0.020
            + ro_u.energy * 0.026 + ro_u.presetBurst * 0.025;
  } else if (ro_u.preset > 3.5) {
    vBright = 0.94 + maxRippleAmp * 0.64 * ro_u.rippleBright + ro_u.bass * 0.08
            + edgeBoost * 0.12 + ro_u.energy * 0.05 + ro_u.pulse * 0.16 + ro_u.presetBurst * 0.16;
  } else {
    // 0.82 → ro_u.brightBase（实验调参可实时改）
    vBright = ro_u.brightBase + maxRippleAmp * 0.55 * ro_u.rippleBright + ro_u.bass * 0.10
            + edgeBoost * 0.30 + ro_u.energy * 0.05 + ro_u.presetBurst * 0.40;
  }
  // 星河不参与预设亮度分组，保持稳定 1.0（闪烁已含在 starCol 里）
  out.glow = select(vBright, 1.0, isStar);
  // 0.55 + 0.45*smoothstep(...) → alphaBase + (1-alphaBase)*smoothstep(...)
  var alpha = select(
    (ro_u.alphaBase + (1.0 - ro_u.alphaBase) * smoothstep(0.0, 1.0, 0.32 + ro_u.energy * 0.60)) * mix(1.0, 0.94, mUse),
    twinkle * 0.75,
    isStar
  );
  // 虚空预设（索引 3）：隐去全部预设粒子，只留星河背景。
  // 这是 Mineradio 的 VOID 原始语义；实测把它画成包围相机的壳层会让加法混合整屏曝白。
  if (voidPreset && !isStar) { alpha = 0.0; }
  // 星河透明度按预设差异化（对齐 Mineradio）：
  // - 预设 7（音域回响 Sonic-Topography）：星河完全不显示
  // - 预设 8（音域回响 Wallpaper Engine）：星河半透明（~0.28）
  // - 其他预设：保持默认
  if (isStar) {
    let presetVal = ro_u.preset;
    if (presetVal > 6.5 && presetVal < 7.5) {
      alpha = 0.0; // preset 7: 隐藏星河
    } else if (presetVal > 7.5 && presetVal < 8.5) {
      alpha = 0.28; // preset 8: 半透明星河
    }
  }
  // 光晕强度：以默认值 1.0 为 1.0 基准，保证出厂观感不变
  // bloom 同时作用于亮度和 alpha，使高值时整体变亮而非仅变透明
  let bloomScale = ro_u.bloom / 0.62;
  out.glow *= bloomScale;
  alpha *= bloomScale;
  out.alpha = alpha;
  out.ripple = select(clamp(rip, 0.0, 1.0), 0.0, isStar);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // 双瓣高斯：锐利核心 + 宽域光晕 —— 单层绘制即有 bloom 观感，
  // 再乘一条平滑收口，边缘没有任何可见硬边
  let d = length(in.uv);
  if (d > 1.0) { discard; }
  let core = exp(-d * d * 5.0);
  let halo = exp(-d * d * 1.50) * 0.42;
  let a = (core + halo) * (1.0 - smoothstep(0.82, 1.0, d));
  if (a < 0.003) { discard; }
  // 亮度已在顶点阶段按 Mineradio 的分组公式算进 in.glow，这里只做线性相乘
  return vec4<f32>(in.color * in.glow, a * in.alpha);
}
`

/**
 * 诊断：回读粒子缓冲里 N 个粒子，检查每个粒子的位置是否 NaN / Inf、是否在相机视锥内。
 *
 * 用途：在切预设后调一次（通过 renderer.checkParticles），确认「粒子被真正摆出来了」，
 * 把问题归因缩小到「着色器分支没走对 / uniform 传错 / 尺寸算错 / 顶点被丢弃」。
 *
 * 判定逻辑（全部基于 position.xyz，不含速度/种子等无关项）：
 *   - NaN/Inf  → compute shader 出了数学错误（常见于 0 除或 sqrt 负数）
 *   - |pos| > radius * 10 → 位置异常远，很可能被某项「位移」参数放大到飞出视野
 *   - viewPos.w <= 0.5 → 粒子在相机背后或贴得太近，会被 clip 丢弃；若所有粒子都这样，
 *     说明相机状态有问题（半径/视角/投影矩阵错误）
 *   - pixelSize < 0.5 → 预期像素直径太小，粒子几乎不可见
 */
function readbackParticlesAndReport(
  device: Any,
  buffer: Any,
  total: number,
  FLOATS_PER_PARTICLE: number,
  radius: number,
  cameraFov: number,
  pixelHeightPx: number,
  tanHalfFov: number,
  currentPreset: number,
): void {
  try {
    // 字节对齐：每粒子 FLOATS_PER_PARTICLE * 4，buffer 字节长度 = total * 这值
    const strideBytes = FLOATS_PER_PARTICLE * 4
    // 每次读 256 个粒子足够覆盖分布，再多意义不大
    const sampleCount = Math.min(256, total)
    const bytesNeeded = sampleCount * strideBytes
    const readBuffer = device.createBuffer({
      size: bytesNeeded,
      usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
    })
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(buffer, 0, readBuffer, 0, bytesNeeded)
    device.queue.submit([encoder.finish()])
    void readBuffer.mapAsync(GPU_MAP_READ).then(() => {
      try {
        const view = new Float32Array(readBuffer.getMappedRange().slice(0))
        let nanCnt = 0
        let farCnt = 0
        let behindCam = 0
        let tiny = 0
        const pointSize = view[13] ?? 0
        const depthSize = (pointSize * radius * 0.062) / Math.max(0.5, radius * 0.8)
        const pxSize = (2 * radius * 0.8 * tanHalfFov * depthSize) / Math.max(1, pixelHeightPx)
        for (let i = 0; i < sampleCount; i++) {
          const o = i * FLOATS_PER_PARTICLE
          const x = view[o], y = view[o + 1], z = view[o + 2]
          const bad = Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)
            || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
          if (bad) { nanCnt++; continue }
          const dist = Math.sqrt(x * x + y * y + z * z)
          if (dist > radius * 10) farCnt++
          // 近似深度：z 轴朝向相机为负（与 webgl2 同坐标系）；-z > 0.5 表示在相机前
          if (z >= -0.5) behindCam++
          if (pxSize < 0.5) tiny++
        }
        console.warn(
          '[particle] WebGPU 粒子诊断 preset=', currentPreset,
          'sample=', sampleCount,
          'nan/inf=', nanCnt,
          'far(>', radius * 10, ')=', farCnt,
          'behindClip(z>=-0.5)=', behindCam,
          'pixelSizeTiny(px<0.5)=', tiny,
          'expectedPxSize=', pxSize.toFixed(2),
          nanCnt > 0 ? '⚠ 着色器出了数学错误（0 除 / sqrt 负数等）' : '',
          farCnt > sampleCount * 0.1 ? '⚠ 大量粒子飞出了合理范围' : '',
          behindCam === sampleCount ? '⚠ 所有粒子都在相机背后' : '',
          tiny > sampleCount * 0.5 && pxSize < 0.1 ? '⚠ 预期像素极小 → 视口高度/焦距参数错' : '',
        )
      } finally {
        try { readBuffer.unmap() } catch { /* 已解绑则忽略 */ }
        try { readBuffer.destroy() } catch { /* 已销毁则忽略 */ }
      }
    })
  } catch (err) {
    console.warn('[particle] WebGPU 粒子诊断失败：', err)
  }
}

/**
 * 诊断：把封面纹理的中间一行像素从 GPU 回读出来打印。
 *
 * 专辑封面「完全没有内容」有三种可能，靠 CPU 侧日志无法区分：
 *   1. 源画布本身是空白（跨域/解码失败）；
 *   2. copyExternalImageToTexture 没把像素真正送进纹理（静默失败）；
 *   3. 纹理没问题，是 coverMix / hasCover 没到位。
 * 本函数一次性回读即可把 2 与 3 彻底分开：回读像素非黑说明 GPU 侧内容正确，
 * 问题必在 coverMix/hasCover；回读全 0 则确认是上传环节。
 * 每次换封面只跑一次，不影响渲染性能。
 */
function readbackCoverRow(device: Any, texture: Any, size: number): void {
  try {
    // bytesPerRow 必须是 256 的整数倍：一行 256 像素 × 4 字节 = 1024，恰好满足
    const bytesPerRow = COVER_TEXTURE_SIZE * 4
    const buffer = device.createBuffer({
      size: bytesPerRow,
      usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
    })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer(
      { texture, origin: { x: 0, y: size >> 1 } },
      { buffer, bytesPerRow },
      [size, 1, 1],
    )
    device.queue.submit([encoder.finish()])
    void buffer.mapAsync(GPU_MAP_READ).then(() => {
      try {
        const row = new Uint8Array(buffer.getMappedRange().slice(0))
        const at = (x: number) => [row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]]
        console.warn(
          '[particle] WebGPU 封面纹理回读（y=' + (size >> 1) + ' 行）',
          'x64=', at(64), 'x128=', at(128), 'x192=', at(192),
          row.every(v => v === 0) ? '⚠ 全 0：纹理内容为空' : '✔ 纹理有内容',
        )
      } finally {
        try { buffer.unmap() } catch { /* 已解绑则忽略 */ }
        try { buffer.destroy() } catch { /* 已销毁则忽略 */ }
      }
    })
  } catch (err) {
    console.warn('[particle] WebGPU 封面纹理回读失败：', err)
  }
}

/** 把 WGSL 编译诊断拼成可读错误信息。 */
function formatCompilationErrors(info: Any): string | null {
  const messages: Any[] = info?.messages ?? []
  const errors = messages.filter(m => m.type === 'error')
  if (errors.length === 0) return null
  return errors
    .map(e => `${e.lineNum ?? '?'}:${e.linePos ?? '?'} ${e.message}`)
    .join(' | ')
}

export async function createWebGPURenderer(
  options: ParticleRendererOptions,
): Promise<ParticleRenderer> {
  const gpu = (navigator as Any).gpu
  if (!gpu) throw new Error('navigator.gpu 不可用')

  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter 请求失败')
  const device: Any = await adapter.requestDevice()

  // WebGPU 的校验错误是**异步**上报的：queue.copyExternalImageToTexture 之类调用
  // 参数不合法时不会抛异常、也不会中断渲染，只在这里出现一条 uncaptured error。
  // 没有这个监听，问题会表现为「初始化成功、粒子在动、但某个效果就是没有内容」，
  // 且日志里干干净净 —— 本次「专辑封面全黑」正是靠它才能一眼定位。
  try {
    const onUncaptured = (event: Any) => {
      console.warn('[particle] WebGPU 未捕获错误：', event?.error?.message ?? event)
    }
    if (typeof device.addEventListener === 'function') {
      device.addEventListener('uncapturederror', onUncaptured)
    } else {
      device.onuncapturederror = onUncaptured
    }
  } catch {
    /* 环境不支持则忽略，不影响渲染 */
  }

  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.touchAction = 'none'
  options.container.appendChild(canvas)

  try {
    const context: Any = canvas.getContext('webgpu')
    if (!context) throw new Error('无法获取 webgpu canvas context')
    // 声明在 use 之前，避免 TS2448（block-scoped variable used before declaration）
    /** 2D 画布上下文：复用同一画布做渲染采样，避免重复获取 */
    let canvas2dCtx: Any = null
    /** 记录上次诊断过的「预设·封面组合」键，避免每帧刷屏 */
    let lastDiagPresetLogged: string | undefined = undefined
    // 同时拿 2D 上下文，后续用于「渲染结果采样」诊断（每预设切一次）
    canvas2dCtx = canvas.getContext('2d', { willReadFrequently: true })
    if (!canvas2dCtx) console.warn('[particle] WebGPU 未获 2D context，渲染采样诊断将跳过')
    const format = gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })

    const count = options.count
    const starCount = options.starCount ?? DEFAULT_STAR_COUNT
    const total = count + starCount
    const radius = options.radius ?? 6
    const plane = options.plane ?? DEFAULT_PLANE

    // ---------- 初始粒子数据 ----------
    // 前 count 个是「预设粒子」（网格布局，每个拿到唯一的封面 uv）；
    // 后面 starCount 个是星河背景层（kind=1，uv 无意义但仍给 0.5 以免出现退化值）
    const grid = Math.max(1, Math.round(Math.sqrt(count)))
    const initial = new Float32Array(total * FLOATS_PER_PARTICLE)
    for (let i = 0; i < total; i++) {
      const isStar = i >= count
      const u = Math.random()
      const v = Math.random()
      const theta = u * Math.PI * 2
      const phi = Math.acos(2 * v - 1)
      // 星河粒子出生在更大的壳层上，避免开场时从中心炸出来
      const r = isStar
        ? plane * (0.85 + Math.random() * 1.35)
        : radius * (0.62 + Math.random() * 0.38)
      const ax = r * Math.sin(phi) * Math.cos(theta)
      const ay = r * Math.sin(phi) * Math.sin(theta)
      const az = r * Math.cos(phi)

      // 封面 UV：取 texel 中心，避免采样到邻格导致边缘串色
      const gx = i % grid
      const gy = Math.floor(i / grid)

      const o = i * FLOATS_PER_PARTICLE
      initial[o] = ax
      initial[o + 1] = ay
      initial[o + 2] = az
      initial[o + 3] = Math.random() // seed
      initial[o + 4] = 0
      initial[o + 5] = 0
      initial[o + 6] = 0
      initial[o + 7] = isStar ? 0.30 + Math.random() * 0.55 : 0.35 + Math.random() * 0.9
      initial[o + 8] = isStar ? 0.5 : (gx + 0.5) / grid
      initial[o + 9] = isStar ? 0.5 : (gy + 0.5) / grid
      initial[o + 10] = isStar ? 1 : 0 // kind
      initial[o + 11] = 0
      initial[o + 12] = ax // anchor
      initial[o + 13] = ay
      initial[o + 14] = az
      initial[o + 15] = 0
    }

    const particleBuffer = device.createBuffer({
      size: initial.byteLength,
      usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST | BUFFER_USAGE.COPY_SRC,
    })
    device.queue.writeBuffer(particleBuffer, 0, initial)

    const uniformData = new ArrayBuffer(UNIFORM_FLOATS * 4)
    const uniformF32 = new Float32Array(uniformData)
    const uniformU32 = new Uint32Array(uniformData)
    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    })
    uniformU32[U.count] = total
    uniformF32[U.radius] = radius
    uniformF32[U.pointSize] = options.pointSize
    uniformF32[U.plane] = plane

    // ---------- 封面纹理 ----------
    // 尺寸恒定（见 COVER_TEXTURE_SIZE），因此纹理与采样器只创建一次，
    // 切歌只覆盖像素内容 —— 不重建 bindGroup，也就没有黑屏/掉帧
    const placeholder = createPlaceholderCover()
    const coverTexture = device.createTexture({
      size: [COVER_TEXTURE_SIZE, COVER_TEXTURE_SIZE, 1],
      format: 'rgba8unorm',
      // COPY_DST 必须来自 TEXTURE_USAGE（0x02），不能用 BUFFER_USAGE 的同名字段（0x08）
      // COPY_SRC 供诊断回读使用
      usage:
        TEXTURE_USAGE.TEXTURE_BINDING |
        TEXTURE_USAGE.COPY_DST |
        TEXTURE_USAGE.COPY_SRC |
        TEXTURE_USAGE.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture(
      { source: placeholder.canvas },
      { texture: coverTexture },
      [COVER_TEXTURE_SIZE, COVER_TEXTURE_SIZE],
    )
    // 深度/边缘纹理：无封面时用 depth=0.5 / edge=0 的中性图占位
    const edgeTexture = device.createTexture({
      size: [256, 256, 1],
      format: 'rgba8unorm',
      // 同上：纹理必须用 TEXTURE_USAGE，否则 COPY_DST 位错成 STORAGE_BINDING，
      // 上传静默失败 → 边缘/深度图全 0 → 封面浮雕与描边全部失效
      usage:
        TEXTURE_USAGE.TEXTURE_BINDING |
        TEXTURE_USAGE.COPY_DST |
        TEXTURE_USAGE.RENDER_ATTACHMENT,
    })
    const neutralEdge = document.createElement('canvas')
    neutralEdge.width = 256
    neutralEdge.height = 256
    const nctx = neutralEdge.getContext('2d')
    if (nctx) {
      const img = nctx.createImageData(256, 256)
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = 128
        img.data[i + 3] = 255
      }
      nctx.putImageData(img, 0, 0)
    }
    device.queue.copyExternalImageToTexture({ source: neutralEdge }, { texture: edgeTexture }, [256, 256])

    const coverSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })

    // ---------- 管线 ----------
    // 用 async 版本创建：WGSL 编译/校验错误是异步上报的，同步 API 只会静默产出坏管线
    const module = device.createShaderModule({ code: WGSL })
    const compilationInfo = await module.getCompilationInfo?.()
    const compileError = formatCompilationErrors(compilationInfo)
    if (compileError) throw new Error(`WGSL 编译失败（将降级到 WebGL 2.0）：${compileError}`)

    const computePipeline: Any = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'cs_main' },
    })

    const renderPipeline: Any = await device.createRenderPipelineAsync({
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

    // compute 阶段经 cs_main → presetTarget() 采样了 u_edgeTex(binding 4) + u_coverSampler(binding 2)，
    // 且 rippleSum/flowField 只用 uniform。故 layout:'auto' 生成的计算布局含 binding 0/1/2/4。
    // 早期版本这里漏了 binding 2（采样器）→ bindGroup 非法 → dispatch 失效，且同一 encoder 内的
    // render pass 一并作废 → WebGPU 后端「初始化成功但完全不出粒子」。务必与上面保持四项齐全。
    const computeBindGroup = device.createBindGroup({
      layout: computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: particleBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: coverSampler },
        { binding: 4, resource: edgeTexture.createView() },
      ],
    })
    const renderBindGroup = device.createBindGroup({
      layout: renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: particleBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: coverSampler },
        { binding: 3, resource: coverTexture.createView() },
        { binding: 4, resource: edgeTexture.createView() },
      ],
    })

    // ---------- 相机（复用 three 的数学工具，不创建渲染器） ----------
    const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 200)
    const projView = new THREE.Matrix4()
    const viewMatrix = new THREE.Matrix4()
    const camRight = new THREE.Vector3()
    const camUp = new THREE.Vector3()
    const camForward = new THREE.Vector3()
    const upHint = new THREE.Vector3(0, 1, 0)

    let lastTime = -1
    let width = 1
    let height = 1
    /** 绘制缓冲的像素高度：把像素点大小换算成世界尺寸时用它 */
    let drawHeightPx = 1
    /** 动效参数（滑杆实时更新） */
    const fx: FxSettings = { ...DEFAULT_FX }

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
      // 锁定水平视野：容器宽高比变化时，保持左右占屏比例与全屏一致
      camera.fov = verticalFovForAspect(camera.aspect)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)

      viewMatrix.copy(camera.matrixWorldInverse)
      projView.multiplyMatrices(camera.projectionMatrix, viewMatrix)

      camForward.set(0, 0, -1).applyQuaternion(camera.quaternion)
      camRight.set(1, 0, 0).applyQuaternion(camera.quaternion)
      camUp.crossVectors(camRight, camForward).normalize()

      for (let i = 0; i < 16; i++) uniformF32[i] = projView.elements[i]
      uniformF32[U.camRight] = camRight.x
      uniformF32[U.camRight + 1] = camRight.y
      uniformF32[U.camRight + 2] = camRight.z
      uniformF32[U.time] = f.time
      uniformF32[U.camUp] = camUp.x
      uniformF32[U.camUp + 1] = camUp.y
      uniformF32[U.camUp + 2] = camUp.z
      const dt = lastTime < 0 ? 1 / 60 : Math.min(0.05, Math.max(0.001, f.time - lastTime))
      lastTime = f.time
      uniformF32[U.dt] = dt
      // 频谱振幅：只缩 bass/mid/treble，energy/pulse 保持原值。
      // 倍率由「实验调参 → 频谱振幅」滑杆实时控制（关闭开关时上层已按 0 下发）。
      uniformF32[U.bass] = f.bass * fx.spectrumAmp
      uniformF32[U.mid] = f.mid * fx.spectrumAmp
      uniformF32[U.treble] = f.treble * fx.spectrumAmp
      uniformF32[U.energy] = f.energy
      uniformF32[U.pulse] = f.pulse
      // 点大小换算用：tan(垂直 FOV / 2) 与绘制缓冲像素高
      uniformF32[U.tanHalfFov] = Math.tan((camera.fov * Math.PI) / 360)
      uniformF32[U.viewportHeightPx] = drawHeightPx
      uniformF32[U.intensity] = fx.intensity
      uniformF32[U.speed] = fx.speed
      uniformF32[U.depth] = fx.depth
      uniformF32[U.twist] = fx.twist
      uniformF32[U.scatter] = fx.scatter
      uniformF32[U.bloom] = fx.bloom
      uniformF32[U.edge] = fx.edge
      uniformF32[U.bgFade] = fx.bgFade
      // ---- 实验调参 ----
      uniformF32[U.spectrumAmp] = fx.spectrumAmp
      uniformF32[U.flowBase] = fx.flowBase
      uniformF32[U.flowBass] = fx.flowBass
      uniformF32[U.flowMid] = fx.flowMid
      uniformF32[U.rippleAmp] = fx.rippleAmp
      uniformF32[U.rippleBright] = fx.rippleBright
      uniformF32[U.pulseBase] = fx.pulseBase
      uniformF32[U.pulseBass] = fx.pulseBass
      uniformF32[U.burstAmp] = fx.burstAmp
      uniformF32[U.reliefAmp] = fx.reliefAmp
      uniformF32[U.sizeBase] = fx.sizeBase
      uniformF32[U.sizeMax] = fx.sizeMax
      uniformF32[U.brightBase] = fx.brightBase
      uniformF32[U.alphaBase] = fx.alphaBase

      const ripples = f.ripples
      for (let i = 0; i < 4; i++) {
        const o = i * 4
        uniformF32[U.ripples + o] = ripples[o]
        uniformF32[U.ripples + o + 1] = ripples[o + 1]
        uniformF32[U.ripples + o + 2] = ripples[o + 2]
        uniformF32[U.ripples + o + 3] = ripples[o + 3]
      }

      device.queue.writeBuffer(uniformBuffer, 0, uniformData)
    }

    const renderer: ParticleRenderer = {
      backend: 'webgpu',
      count,
      resize(w: number, h: number) {
        width = Math.max(1, Math.floor(w))
        height = Math.max(1, Math.floor(h))
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(width * dpr)
        canvas.height = Math.floor(height * dpr)
        drawHeightPx = canvas.height
      },
      setCover(cover) {
        if (!cover || !cover.hasImage) {
          uniformF32[U.hasCover] = 0
          uniformF32[U.coverLum] = 0.5
          return
        }
        if (cover.canvas.width !== COVER_TEXTURE_SIZE || cover.canvas.height !== COVER_TEXTURE_SIZE) {
          // 尺寸不符会被 copyExternalImageToTexture 直接拒绝 —— 这是本文件的硬约定
          console.warn('[particle] 封面画布尺寸不符，已忽略：', cover.canvas.width, cover.canvas.height)
          return
        }
        try {
          device.queue.copyExternalImageToTexture(
            { source: cover.canvas },
            { texture: coverTexture },
            [COVER_TEXTURE_SIZE, COVER_TEXTURE_SIZE],
          )
        } catch (err) {
          // 跨域画布等情况：保留上一张封面，不打断渲染
          console.warn('[particle] 封面上传失败：', err)
          return
        }
        // 一次性回读：确认像素是否真的进了 GPU 纹理（区分「源画布空白」与「上传失败」）
        readbackCoverRow(device, coverTexture, COVER_TEXTURE_SIZE)
        // 诊断：源画布中心像素 —— 用于区分「画布本身空白」与「WebGPU 上传失败」
        try {
          const c2 = cover.canvas.getContext('2d')
          const px = c2?.getImageData(COVER_TEXTURE_SIZE >> 1, COVER_TEXTURE_SIZE >> 1, 1, 1)?.data
          console.warn('[particle] WebGPU 封面源画布中心像素 rgba=', px ? [px[0], px[1], px[2], px[3]] : '无法读取')
        } catch (e) {
          console.warn('[particle] WebGPU 封面源画布读取失败（可能跨域）：', e)
        }
        if (cover.edgeCanvas) {
          try {
            device.queue.copyExternalImageToTexture(
              { source: cover.edgeCanvas },
              { texture: edgeTexture },
              [256, 256],
            )
          } catch (err) {
            console.warn('[particle] 深度/边缘纹理上传失败：', err)
          }
        }
        uniformF32[U.hasCover] = 1
        uniformF32[U.coverLum] = cover.luminance
        console.warn('[particle] WebGPU 封面已上传：hasCover=1 coverLum=', cover.luminance)
      },
      setCoverMix(mix: number) {
        uniformF32[U.coverMix] = Math.max(0, Math.min(1, mix))
      },
      setFx(next) {
        Object.assign(fx, next)
      },
      setSkullPoints(positions) {
        if (!positions || positions.length < 3) return
        const n = Math.min(count, Math.floor(positions.length / 3))
        for (let i = 0; i < n; i++) {
          const base = i * FLOATS_PER_PARTICLE
          initial[base + 12] = positions[i * 3]
          initial[base + 13] = positions[i * 3 + 1]
          initial[base + 14] = positions[i * 3 + 2]
          // 同时把当前位置拉到骷髅形态，避免弹簧从旧位置慢慢爬过去
          initial[base] = positions[i * 3]
          initial[base + 1] = positions[i * 3 + 1]
          initial[base + 2] = positions[i * 3 + 2]
        }
        device.queue.writeBuffer(particleBuffer, 0, initial)
      },
      setPreset(preset: number) {
        uniformF32[U.preset] = preset
        // 切预设后延迟 1.5s 做一次粒子诊断：此时 compute 已完成一轮，位置已落位
        setTimeout(() => {
          console.warn('[particle] WebGPU 切预设诊断 start preset=', preset)
          readbackParticlesAndReport(
            device, particleBuffer, total, FLOATS_PER_PARTICLE,
            radius, camera.fov, drawHeightPx,
            uniformF32[U.tanHalfFov],
            preset,
          )
        }, 1500)
      },
      setPresetBurst(value: number) {
        uniformF32[U.presetBurst] = Math.max(0, Math.min(1, value))
      },
      update(features: AudioFeatures, c: CameraState) {
        writeUniforms(features, c)
      },
      render() {
        const encoder: Any = device.createCommandEncoder()
        const workgroups = Math.ceil(total / 64)
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
        rp.draw(6, total)
        rp.end()

        device.queue.submit([encoder.finish()])
        // 渲染完做一次轻量颜色采样：在画布左上/右上/左下/右下各取 1 像素，
        // 若四周全黑 (0.031/0.031/0.047 清屏底色) 说明「没有任何粒子被渲染出来」。
        // 这是 13 个预设通用的视觉完整性探针：任何预设失败都能被这一条抓住。
        // 节流：仅当 preset 或 coverMix 变化时才采样，避免 60fps 刷屏。
        const diagKey = `${Math.round(uniformF32[U.preset] * 10)}.${Math.round(uniformF32[U.coverMix] * 10)}`
        if (diagKey !== lastDiagPresetLogged) {
          lastDiagPresetLogged = diagKey
          try {
            const c2d = canvas.getContext('2d', { willReadFrequently: true }) as Any
            if (!c2d) return
            const corners = [
              { x: 8, y: 8, label: '左上' },
              { x: canvas.width - 9, y: 8, label: '右上' },
              { x: 8, y: canvas.height - 9, label: '左下' },
              { x: canvas.width - 9, y: canvas.height - 9, label: '右下' },
            ]
            const samplePoints = corners
              .map(({ x, y, label }) => {
                const d = c2d?.getImageData(x, y, 1, 1)?.data
                if (!d) return { label, rgba: null }
                return { label, rgba: [d[0], d[1], d[2], d[3]] }
              })
            const allClear = samplePoints.every((p: Any) => !p.rgba || (p.rgba[0] <= 8 && p.rgba[1] <= 8 && p.rgba[2] <= 8))
            console.warn(
              '[particle] WebGPU 渲染采样 preset=', uniformF32[U.preset],
              '画面尺寸=', canvas.width, 'x', canvas.height,
              '四角采样=', JSON.stringify(samplePoints.map((p: Any) => ({ ...p, rgba: p.rgba ? p.rgba.slice(0, 3) : 'no2d' }))),
              allClear ? '⚠ 四角均为清屏底色 → 画布未被任何粒子填充（渲染失败）' : '✔ 画布有内容',
            )
          } catch (err) {
            console.warn('[particle] WebGPU 渲染采样失败：', err)
          }
        }
      },
      dispose() {
        particleBuffer.destroy?.()
        uniformBuffer.destroy?.()
        coverTexture.destroy?.()
        edgeTexture.destroy?.()
        canvas.remove()
      },
    }

    return renderer
  } catch (err) {
    // 初始化失败必须把 canvas 摘掉，否则会残留一层黑幕盖住屏幕
    canvas.remove()
    throw err
  }
}
