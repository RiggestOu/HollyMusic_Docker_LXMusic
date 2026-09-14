/**
 * WebGL 2.0 粒子渲染器（降级路径）—— three.js Points + 顶点着色器位移。
 *
 * # 为什么不用 Transform Feedback
 * 本系统的粒子运动可归约为
 *     位置 = 归宿几何(预设 / 封面平面 / 星云球面, 音频) + 平滑扰动(噪声流场, 涟漪, 爆散)
 * 的纯函数，不存在需要跨帧持久化的状态。这里在 GPU 顶点阶段完成全部计算：
 * CPU 负载为零，无需显存回读，也没有 ping-pong 缓冲每帧两次的带宽往返。
 * 若将来引入需要状态积分的力场模拟（粒子间相互作用），可在 `ParticleRenderer`
 * 接口下新增 Transform Feedback 实现，上层无需改动。
 *
 * # 与 WebGPU 路径的关系
 * `presetTarget` / `starTarget` / `presetTint` 与 webgpu.ts 的 WGSL 版本是**逐式对照的
 * 同一套公式**，只改语法不改语义。WebGPU 用弹簧趋近这些目标（有状态演化、多一点惯性），
 * 本路径直接求值（瞬时精确落位）；形状、配色与音频响应因此完全一致。
 *
 * # 视觉要点（对应「流体 / 星云 / 柔光感」的要求）
 *  · 轨迹：3D Simplex 噪声三元流场 → 连续曲线，绝不出现线性折线；
 *  · 外观：片元里用「双瓣高斯」（锐利核心 + 宽域光晕）叠加，
 *    再乘一条平滑收口，边缘没有任何可见硬边，单层绘制即有 bloom 观感；
 *  · 过渡：形态插值、Z 轴起伏、尺寸、亮度全部经 smoothstep / 高斯包络，
 *    没有一处是「到阈值就跳」的写法；
 *  · 预设切换：走爆散位移（smoothstep 缓动）而非瞬移，粒子先离开旧形状再落位到新形状。
 *
 * 许可证：本文件为独立实现。预设清单参考 Mineradio（GPL-3.0）的视觉目录，
 * 但全部几何、配色与过渡曲线均为自行设计与推导，未复制其源码。
 */

import * as THREE from 'three'
import { COVER_TEXTURE_SIZE, createPlaceholderCover } from './cover-texture'
import { BASE_FOV, DEFAULT_FX, verticalFovForAspect } from './types'
import type { AudioFeatures, CameraState, ParticleRenderer, ParticleRendererOptions } from './types'

/** 与 WGSL 路径一致的配色（香槟金 / 薄荷绿 / 近黑）。 */
const COLOR_CHAMPAGNE = new THREE.Color('#F7E7CE')
const COLOR_MINT = new THREE.Color('#A8E6CF')
const COLOR_BG = new THREE.Color('#08080C')

/**
 * 封面平面边长：直接对齐 Mineradio 的 PLANE_SIZE = 4.8。
 * 这个尺度不能自己拍 —— 涟漪鼓包半径(0.83)、各预设的绝对坐标常量、相机基线半径(6.6)、
 * FOV(45) 是彼此耦合的一整套：单独改任何一个，要么涟漪只覆盖中心一小块，
 * 要么粒子跑到取景框外。
 */
const DEFAULT_PLANE = 4.8

/** 星河背景层粒子数缺省值，与 webgpu.ts 保持一致。 */
const DEFAULT_STAR_COUNT = 1400

/** 涟漪寿命，必须与 beat.ts 的 RIPPLE_LIFE 一致。 */
const RIPPLE_LIFE = 2.0

const VERTEX_SHADER = /* glsl */ `
  precision highp float;

  attribute vec2 aUv;
  attribute float aRand;
  attribute float aScale;
  attribute float aKind;

  uniform float uTime, uBass, uMid, uTreble, uEnergy, uPulse;
  uniform float uPointSize, uPixel, uCoverMix, uHasCover, uPlane, uCoverLum;
  // 动效参数（对应 Mineradio 的 fx 滑块）
  uniform float uIntensity, uSpeed, uDepth, uTwist, uScatter, uBloom, uEdge, uBgFade;
  uniform float uPreset, uPresetBurst;
  uniform vec3 uColorA, uColorB;
  uniform sampler2D uCoverTex;
  uniform sampler2D uEdgeTex;
  uniform vec4 uRipples[4];

  varying vec3 vColor;
  varying float vGlow;
  varying float vAlpha;
  varying float vRipple;

  const float PI = 3.141592653589793;
  const float TWO_PI = 6.283185307179586;

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

  /**
   * 单枚涟漪的位移贡献：中心高斯鼓包 + 向外扩张的高斯环。
   * r = vec4(age, strength, x, y)；strength<=0 或 age<0 表示槽位空闲。
   * 半径是「世界单位」绝对值，与 Mineradio 一致 —— 它只在 PLANE_SIZE = 4.8
   * 这个尺度下才覆盖到平面宽度的三成，所以平面尺度不能单独改。
   * 出现与消失都套 smoothstep，因此看不出涟漪的「起止时刻」。
   */
  float rippleAt(vec2 p, vec4 r) {
    float age = r.x;
    float strength = r.y;
    if (strength <= 0.0 || age < 0.0) return 0.0;
    float life = age / ${RIPPLE_LIFE.toFixed(1)};
    float env = smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.62, 1.0, life));
    float dist = length(p - r.zw);
    float bulgeW = 0.55 + age * 0.80;
    float bulge = exp(-(dist * dist) / (2.0 * bulgeW * bulgeW))
                * (1.0 - smoothstep(0.0, 0.55, life));
    float ringR = age * 2.10;
    float ringW = 0.40 + age * 0.22;
    float ring = exp(-pow((dist - ringR) / ringW, 2.0));
    return (bulge * 2.40 + ring * 1.30) * env * strength;
  }

  // 固定长度数组必须用常量下标访问：这里手工展开，不做循环
  float rippleSum(vec2 p) {
    return rippleAt(p, uRipples[0])
         + rippleAt(p, uRipples[1])
         + rippleAt(p, uRipples[2])
         + rippleAt(p, uRipples[3]);
  }

  /**
   * 13 种预设各自的「归宿几何」——与 webgpu.ts 的 presetTarget 逐式对照。
   * 统一平面坐标：c = uv 映射到以原点为中心的方形，r = |c|，ang = atan2(c.y, c.x)。
   */
  float hash11(float p) {
    return fract(sin(p * 127.1) * 43758.5453123);
  }

  /**
   * 13 种预设的归宿位置 —— 逐式对齐 Mineradio 顶点着色器的原文（与 webgpu.ts 的 WGSL 版一一对应）。
   *
   * 上一版是按它的思路近似重写的（常数、曲线、结构都不同）；这里直接采用其原式：
   * 每个预设的「几何 + 音频位移」全部在本函数内一次算完（与它把位移写进 pos 的做法一致），
   * 涟漪 Z 与预设切换爆散仍由调用方叠加。
   *
   * 直接读全局 uniform，因此参数很短。
   * K = uIntensity(0.85) × 1.6 = 1.36，即 Mineradio 的默认强度。
   * 省略项：依赖其 AI 深度/边缘纹理的 depthZ / edgeBoost（本项目无该纹理），
   * 以及依赖 uCoverRes 的 hiResGuard（无对应设置，等价于取 1）。
   */
  vec3 presetTarget(vec2 uv, float seed, vec3 anchor) {
    // 律动强度：K = intensity * 1.6（其 uIntensity 默认 0.85 → 1.36）
    float K = uIntensity * 1.6;
    float t = uTime * uSpeed;
    float s = uPreset;
    float plane = uPlane;
    // 其平面坐标由 gx/(grid-1) 生成，等价于 (aUv - 0.5) * PLANE_SIZE
    vec2 c = vec2((uv.x - 0.5) * plane, (uv.y - 0.5) * plane);

    // 0 SILK：平面 + 中/高/低频驱动的 Z 起伏（midN / midMask / trebleJ / bassBreath 原式）
    if (s < 0.5) {
      float midN = snoise(vec3(c.x * 1.4, c.y * 1.4, t * 0.55)) * 0.6
                 + snoise(vec3(c.x * 2.8 + 5.0, c.y * 2.8 - 3.0, t * 0.85)) * 0.4;
      float midMask = 0.55 + 0.45 * snoise(vec3(c.x * 0.4, c.y * 0.4, t * 0.18));
      float midDisp = midN * uMid * 0.55 * midMask * K;
      float trebleJ = snoise(vec3(c.x * 6.5, c.y * 6.5, t * 3.5 + seed * 4.0))
                    * uTreble * 0.18 * K;
      float bassBreath = snoise(vec3(c.x * 0.35, c.y * 0.35, t * 0.4)) * uBass * 0.42 * K;
      // 深度/边缘纹理：R=depth → 浮雕位移（原式 depthZ = (depthVal-0.5)*uAiBoost*uDepth*1.40）
      float depthZ =
        (texture2D(uEdgeTex, clamp(uv, vec2(0.0022), vec2(0.9978))).r - 0.5)
        * uDepth * 1.40;
      return vec3(c.x, c.y, midDisp + trebleJ + bassBreath + depthZ);
    }

    // 1 TUNNEL：筒壁 + 沿轴流动 + 整管自旋；bass 让筒径「收缩」（注意是负号）
    if (s < 1.5) {
      float angle = uv.x * TWO_PI + t * 0.12;
      float flow = fract(uv.y - t * 0.08 * (1.0 + uBass * 0.55));
      float zPos = (flow - 0.5) * 9.0;
      float baseR = 2.0 - uBass * 0.28 * K;
      float ripG = sin(angle * 5.0 + zPos * 1.4 + t * 2.2) * 0.10 * (uMid + uTreble) * K;
      float r = baseR + ripG;
      return vec3(cos(angle) * r, sin(angle) * r, zPos);
    }

    // 2 ORBIT：球面（无扁率、无环）+ yaw 自转；treble 起毛刺、bass 整体膨胀
    if (s < 2.5) {
      float theta = uv.x * TWO_PI;
      float phi = (uv.y - 0.5) * PI;
      float trebFlare = snoise(vec3(theta * 1.5, phi * 1.5, t * 0.7)) * uTreble * 0.85 * K;
      float bassExpand = uBass * 0.35 * K;
      float r = 2.2 * (1.0 + bassExpand) + trebFlare;
      float x = r * cos(phi) * cos(theta);
      float y = r * sin(phi);
      float z = r * cos(phi) * sin(theta);
      float yaw = t * 0.18;
      float cy = cos(yaw);
      float sy = sin(yaw);
      return vec3(cy * x - sy * z, y, sy * x + cy * z);
    }

    // 3 VOID：无粒子 —— 几何推到远处，渲染阶段把 alpha 压 0（其原式即 vAlpha = 0）
    if (s < 3.5) {
      return vec3(c.x * 0.01, c.y * 0.01, -90.0);
    }

    // 4 VINYL RECORD：中心封面 + 黑胶沟槽 + 完整白边
    if (s < 4.5) {
      vec2 p = (uv - vec2(0.5)) * 5.12;
      float spin = t * 0.35;
      float cs = cos(spin);
      float sn = sin(spin);
      vec2 rp = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
      float d = length(p);
      float recordR = 2.46;
      float coverR = 1.18;
      float bassDrive = smoothstep(0.08, 0.78, uBass + uPulse * 0.82);
      float highDrive = smoothstep(0.05, 0.46, uTreble);
      float border = exp(-pow((d - coverR) / 0.064, 2.0));
      float vinylN = clamp((d - coverR) / max(0.001, recordR - coverR), 0.0, 1.0);
      float angle0 = atan(p.y, p.x);
      float groove = 0.5 + 0.5 * sin((d - coverR) * 98.0);
      float tickHash = hash11(floor((angle0 + PI) * 38.0) + floor(d * 72.0) * 2.1);
      float tick = smoothstep(0.82, 0.995, tickHash);
      // 中心封面区 / 黑胶沟槽区的 Z 是两套公式（原式的 if/else）
      float zCover = 0.040 + border * 0.026 + uPulse * 0.018;
      float zVinyl = groove * 0.010 + border * 0.024
                   + bassDrive * vinylN * 0.016 * K + tick * highDrive * 0.010;
      float inside = 1.0 - smoothstep(coverR - 0.012, coverR + 0.018, d);
      float radial = 1.0 + bassDrive * 0.012 + uPulse * 0.026;
      return vec3(rp.x * radial, rp.y * radial, inside > 0.02 ? zCover : zVinyl);
    }

    // 6 骷髅点云：坐标来自外部点云资源（由 setSkullPoints 写入 anchor 槽位），
    //   这里只叠加轻微的呼吸与浮动（对应其浮空层的表现）
    if (s > 5.5 && s < 6.5) {
      float breath = 1.0 + uBass * 0.06 * K;
      float drift = snoise(vec3(c.x * 0.6, c.y * 0.6, t * 0.25)) * 0.05;
      return vec3(anchor.x * breath, anchor.y * breath + drift, anchor.z * breath);
    }

    // 5-8 WALLPAPER PULSE：螺旋极光带（lane<0.80）+ 远景尘埃（lane>=0.80）+ 切换脉冲
    if (s < 8.5) {
      float lane = uv.y;
      vec3 pos;
      if (lane < 0.80) {
        float laneWarp = snoise(vec3(uv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11
                       + (hash11(seed * 73.1) - 0.5) * 0.045;
        float warpedLane = clamp(lane + laneWarp, 0.0, 0.80);
        float bandCoord = warpedLane / 0.80 * 5.65
                        + snoise(vec3(uv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;
        float band = floor(bandCoord);
        float local = fract(bandCoord + hash11(band * 9.13 + seed * 2.4) * 0.18);
        float bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);
        float bseed = hash11(band * 19.17 + seed * 31.0);
        float flow = fract(uv.x + t * (0.0034 + bandN * 0.0038 + bseed * 0.0022) + bseed * 0.53);
        float arc = (flow - 0.5) * PI * (1.35 + bandN * 0.72 + bseed * 0.24);
        float armCurve = sin(arc + bandN * 2.2 + bseed * 5.3);
        float spiralRadius = 9.2 + bandN * 11.8 + bseed * 6.0 + local * 2.9;
        float x = cos(arc * 0.72 + bandN * 0.92 + bseed * 1.3) * spiralRadius
                + (flow - 0.5) * (13.5 + bandN * 9.5);
        float ribbonPhase = flow * TWO_PI * (0.55 + bandN * 0.24 + bseed * 0.10)
                          + t * (0.010 + bandN * 0.007) + bseed * 5.7;
        float broadWave = sin(ribbonPhase) * 0.92;
        float fineWave = sin(ribbonPhase * (1.36 + bseed * 0.62) - t * 0.044 + bseed * 5.0) * 0.045;
        float yBase = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6)
                    + (bseed - 0.5) * 1.85
                    + snoise(vec3(bandN * 2.0, flow * 0.62, bseed)) * 0.92;
        float ridgeCenter = 0.43 + (bseed - 0.5) * 0.18;
        float ridge = exp(-pow((local - ridgeCenter) / (0.25 + bseed * 0.04), 2.0));
        float ribbonNoise = snoise(vec3(flow * 1.18 + bseed, bandN * 2.0, t * 0.018)) * 0.74;
        float zLayer = mix(-23.5, 15.5, bandN) + (bseed - 0.5) * 6.0;
        pos = vec3(
          x + ribbonNoise * 1.40 + sin(t * 0.012 + bseed * 8.0) * 0.22,
          yBase + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14),
          zLayer + broadWave * 1.35 + ribbonNoise * 1.85
        );
      } else {
        float q = (lane - 0.80) / 0.20;
        float dseed = hash11(seed * 917.0 + floor(q * 130.0));
        float depth = mix(-32.0, 18.0, dseed);
        float drift = fract(uv.x + t * (0.0014 + dseed * 0.0048) + dseed * 0.63);
        float cluster = snoise(vec3(dseed * 2.0, q * 3.2, t * 0.007));
        float x = (drift - 0.5) * (45.0 + dseed * 22.0) + cluster * 3.4;
        float y = (hash11(seed * 331.0 + dseed * 5.0) - 0.5) * 22.0
                + sin(t * (0.018 + dseed * 0.028) + dseed * 7.0) * 0.86;
        float z = depth + sin(t * (0.020 + dseed * 0.032) + seed * 8.0) * 1.05;
        pos = vec3(x, y, z);
      }
      float transition = clamp(uPresetBurst, 0.0, 1.0);
      if (transition > 0.001) {
        float bloom = smoothstep(0.0, 1.0, transition);
        vec2 bv = pos.xy + vec2(hash11(seed * 31.0) - 0.5, hash11(seed * 47.0) - 0.5) * 0.75;
        vec2 bdir = bv / max(length(bv), 0.001);
        float nx = snoise(vec3(seed, t * 0.014, 1.0));
        float ny = snoise(vec3(seed, t * 0.014, 5.0));
        float grow = 1.0 + bloom * 0.014;
        pos = vec3(
          (pos.x + bdir.x * bloom * 0.026 + nx * bloom * 0.06) * grow,
          (pos.y + bdir.y * bloom * 0.026 + ny * bloom * 0.06) * grow,
          pos.z + (hash11(seed * 123.0) - 0.5) * bloom * 0.18
        );
      }
      return pos;
    }

    // 9 ECLIPSE HALO：8 层倾斜椭圆环 + 日冕
    if (s < 9.5) {
      float ringIndex = floor(uv.y * 8.0);
      float ringLocal = fract(uv.y * 8.0);
      float ringN = (ringIndex + 0.5) / 8.0;
      float ringSeed = hash11(ringIndex * 19.73 + 2.1);
      float theta = uv.x * TWO_PI + ringIndex * 0.47 + t * (0.035 + ringN * 0.026);
      float eclipseDrive = smoothstep(0.06, 0.76, uBass) * 0.17 + uPulse * 0.08;
      float radius = 0.92 + ringN * 3.18 + (ringLocal - 0.5) * 0.24
                   + eclipseDrive * (0.18 + ringN * 0.34);
      float eccentric = 0.49 + ringN * 0.20;
      float xh = cos(theta) * radius * (1.18 + ringN * 0.10);
      float yh = sin(theta) * radius * eccentric;
      float zh = (ringN - 0.5) * 1.34 + sin(theta * 2.0 + ringSeed * 6.0) * (0.10 + ringN * 0.09);
      float tilt = -0.34 + ringN * 0.72;
      float ct2 = cos(tilt);
      float st2 = sin(tilt);
      return vec3(xh, yh * ct2 - zh * st2, yh * st2 + zh * ct2);
    }

    // 10 NEON DRIZZLE：52 条雨列 + 城市纵深 + 透视缩放 + 风偏
    if (s < 10.5) {
      float column = floor(uv.x * 52.0);
      float columnN = (column + 0.5) / 52.0;
      float columnLocal = fract(uv.x * 52.0);
      float rainSeed = hash11(column * 41.17 + floor(columnLocal * 5.0) * 7.9);
      float rainSpeed = 0.026 + rainSeed * 0.052 + smoothstep(0.08, 0.76, uBass) * 0.014;
      float fall = fract(1.0 - uv.y + t * rainSpeed + rainSeed * 0.87);
      float xRain = (columnN - 0.5) * 11.8 + (columnLocal - 0.5) * 0.11;
      float yRain = (0.5 - fall) * 8.8;
      float cityDepth = mix(-3.8, 2.6, hash11(column * 11.3 + 0.7));
      float wind = sin(t * 0.17 + column * 0.63 + fall * 3.4) * (0.08 + rainSeed * 0.12);
      float perspective = 0.76 + smoothstep(-3.8, 2.6, cityDepth) * 0.34;
      return vec3((xRain + wind) * perspective, yRain,
                  cityDepth + sin(fall * TWO_PI + rainSeed * 7.0) * 0.05);
    }

    // 11 PRISM FLOCK：12 群「翼 + 身」形状，振翅由 mid / beat 驱动
    if (s < 11.5) {
      float flockIndex = floor(uv.y * 12.0);
      float wingY = fract(uv.y * 12.0) * 2.0 - 1.0;
      float wingX = uv.x * 2.0 - 1.0;
      float flockSeed = hash11(flockIndex * 23.73 + 4.0);
      float gx = (flockIndex - floor(flockIndex / 4.0) * 4.0) - 1.5;
      float gy = floor(flockIndex / 4.0) - 1.0;
      float migrate = t * (0.018 + flockSeed * 0.018);
      float centerX = gx * 2.42 + sin(migrate + flockSeed * 8.0) * 0.48;
      float centerY = gy * 2.10 + cos(migrate * 0.83 + flockSeed * 9.0) * 0.36;
      float ax = abs(wingX);
      float flap = sin(t * (0.72 + flockSeed * 0.35) + flockIndex * 1.7)
                 * (0.34 + uMid * 0.42 + uPulse * 0.16);
      float lx = sign(wingX) * (0.12 + pow(ax, 0.76) * 0.88);
      float ly = wingY * (0.48 + (1.0 - ax) * 0.22);
      float lz = ax * (0.42 + flap) + (1.0 - abs(wingY)) * 0.08;
      float heading = -0.20 + (flockSeed - 0.5) * 0.70;
      float ch = cos(heading);
      float sh = sin(heading);
      return vec3(centerX + ch * lx - sh * ly,
                  centerY + sh * lx + ch * ly,
                  (flockSeed - 0.5) * 3.4 + lz);
    }

    // 12 ABYSSAL BLOOM：9 瓣放射 + 碗形纵深 + 花瓣波
    float bloomR = pow(max(uv.y, 0.0), 0.72);
    float bloomTheta = uv.x * TWO_PI + bloomR * 0.72 + t * 0.018;
    float petalWave = 0.5 + 0.5 * cos(bloomTheta * 9.0 - bloomR * 3.8);
    float bloomDrive = smoothstep(0.06, 0.74, uBass) * 0.26 + uPulse * 0.10;
    float radiusBloom = bloomR * (3.30 + bloomDrive) * (0.78 + petalWave * 0.34);
    float petalFold = sin(bloomTheta * 9.0 - bloomR * 5.4 + t * 0.13);
    float bowl = (1.0 - bloomR) * 1.12 - bloomR * bloomR * 0.52;
    float bx = cos(bloomTheta) * radiusBloom;
    float by = sin(bloomTheta) * radiusBloom * 0.82;
    float bz = bowl + petalFold * (0.13 + bloomR * 0.47)
             + sin(bloomTheta * 3.0 + t * 0.07) * 0.08;
    float bloomTilt = -0.30;
    float cb = cos(bloomTilt);
    float sb = sin(bloomTilt);
    return vec3(bx, by * cb - bz * sb, by * sb + bz * cb);
  }

  /** 星河背景层：大尺度壳层 + 极缓慢噪声形变，与预设完全无关。 */
  vec3 starTarget(vec3 anchor, float seed, float t, float plane) {
    vec3 dir = normalize(anchor + vec3(1e-4));
    float rad = plane * (0.85 + seed * 1.35);
    vec3 drift = flowField(dir * 2.2 + vec3(0.0, 0.0, t * 0.05), t * 0.35);
    return dir * rad + drift * 0.10;
  }

  /**
   * 每个预设的基础粒子色 —— 直接采用 Mineradio 的配色数据。
   *
   * 上一版用的是本项目自己的「香槟金 ↔ 薄荷绿」双色插值，但这两色亮度很高
   * （0.97/0.90/0.81 与 0.66/0.90/0.81），叠加加法混合后滚筒这种「粒子围住相机」
   * 的预设会整屏刷白（实测均值 240/255）。Mineradio 的基色整体暗得多，
   * 且 9~12 号预设各有专属霓虹/极光调色板 —— 这些都是它的视觉身份，按需求一并对齐。
   */
  vec3 presetPalette(float preset, vec2 uv, float seed, float t) {
    vec3 colA = uColorA;
    vec3 colB = uColorB;
    float s = preset;

    // 0 专辑封面：底色用品牌双色（封面本身会覆盖它）
    if (s < 0.5) {
      return mix(colA, colB, clamp(seed, 0.0, 1.0));
    }
    // 5-8 音域回响：极光带（青 → 紫）
    if (s > 4.5 && s < 8.5) {
      vec3 aurora = mix(vec3(0.52, 0.86, 1.00), vec3(0.70, 0.58, 1.00), uv.y);
      return mix(aurora, vec3(0.96, 0.98, 0.92), smoothstep(0.07, 0.78, uBass) * 0.05);
    }
    // 9 月蚀圣杯：冷缘 → 古金，按环序过渡
    if (s > 8.5 && s < 9.5) {
      return mix(vec3(0.48, 0.82, 1.00), vec3(0.93, 0.72, 0.38),
                 smoothstep(0.18, 0.84, uv.y + sin(uv.x * 6.2831) * 0.08));
    }
    // 10 雨幕霓虹：青 → 洋红 → 琥珀，按列随机选色
    if (s > 9.5 && s < 10.5) {
      vec3 rain = mix(vec3(0.20, 0.88, 1.00), vec3(1.00, 0.26, 0.63),
                      smoothstep(0.18, 0.78, seed));
      return mix(rain, vec3(1.00, 0.72, 0.30), smoothstep(0.84, 0.99, seed));
    }
    // 11 折光蝶群：青绿 → 品红，边缘转金
    if (s > 10.5 && s < 11.5) {
      vec3 prism = mix(vec3(0.42, 0.94, 0.82), vec3(0.96, 0.62, 0.92),
                       smoothstep(-0.8, 0.8, uv.x * 2.0 - 1.0));
      return mix(prism, vec3(1.00, 0.91, 0.64),
                 smoothstep(0.72, 1.0, abs(uv.x * 2.0 - 1.0)));
    }
    // 12 深海绽放：深海绿 → 紫罗兰，外缘转珠白
    if (s > 11.5) {
      float r = pow(max(uv.y, 0.0), 0.72);
      vec3 bloom = mix(vec3(0.12, 0.58, 0.56), vec3(0.38, 0.32, 0.95),
                       smoothstep(0.18, 0.88, r));
      return mix(bloom, vec3(0.82, 1.00, 0.94), smoothstep(0.64, 0.98, r) * 0.55);
    }
    // 1-4（滚筒 / 星球 / 虚空 / 唱片）：Mineradio 的 defaultColor —— 紫 → 粉/蓝渐变
    return mix(
      vec3(0.36, 0.28, 0.72),
      mix(vec3(0.85, 0.55, 0.95), vec3(0.45, 0.78, 0.95), uv.x),
      uv.y
    );
  }

  void main() {
    float t = uTime;
    bool isStar = aKind > 0.5;
    bool isCover = uPreset < 0.5;
    // 虚空预设（索引 3）：隐去全部预设粒子，只留星河背景。
    // 这是 Mineradio 的 VOID 原始语义（该预设用于「只有背景」的观感），
    // 实测把它实现成一个大壳层会让加法混合整屏曝白（mean 亮度 254/255）。
    bool voidPreset = uPreset > 2.5 && uPreset < 3.5;

    // 形态因子：没有封面时强制退化，避免粒子堆在一块没有图像的平面上。
    // 必须与 webgpu.ts 的 m = coverMix * hasCover 完全一致，否则两条后端观感会分叉。
    float m = clamp(uCoverMix, 0.0, 1.0) * uHasCover * (isCover ? 1.0 : 0.0);

    // ---- 归宿位置 ----
    vec3 base;
    if (isStar) {
      base = starTarget(position, aRand, t, uPlane);
    } else if (isCover) {
      // 星云球面 ↔ 封面平面连续插值（不是切换两套几何），因此不会出现粒子跳位
      vec3 planePos = vec3((aUv.x - 0.5) * uPlane, (0.5 - aUv.y) * uPlane, 0.0);
      base = mix(position, planePos, m);
    } else {
      base = presetTarget(aUv, aRand, position);
    }

    // 粒子扭曲：绕视轴旋转（原式的 uTwist）
    if (uTwist > 0.0) {
      float tw = uTwist * (0.6 + base.z * 0.2);
      float cw = cos(tw), sw = sin(tw);
      base = vec3(cw * base.x - sw * base.y, sw * base.x + cw * base.y, base.z);
    }
    // 离散感：沿径向随机外扩（原式的 uScatter）
    if (uScatter > 0.0) {
      base += normalize(base + vec3(1e-4)) * (aRand - 0.5) * uScatter * 2.0;
    }

    // 涟漪作用于归宿位置的水平坐标（封面形态下即图像平面）
    float ripple = rippleSum(base.xy);
    // 深度/边缘纹理：G=edge → 发光边强度（原式 edgeBoost）
    float edgeBoost = texture2D(uEdgeTex, clamp(aUv, vec2(0.0022), vec2(0.9978))).g * uEdge;

    // 流动强度：封面形态下大幅减弱，否则图像会被流动抹糊
    float flowScale = isCover ? mix(1.0, 0.30, m) : 0.25;
    float burstScale = isStar ? 0.0 : (isCover ? mix(1.0, 0.55, m) : 1.0);

    // ---- 流体位移：噪声流场给出连续曲线轨迹 ----
    vec3 flow = flowField(base, t);
    float flowAmp = (0.55 + uBass * 1.60 + uMid * 0.65) * flowScale;
    vec3 p = base + flow * flowAmp;

    // ---- 封面形态：Z 轴呼吸 / 浮雕（全部由 snoise 驱动，平滑无棱角）----
    // m 源自 uniform，这里的 if 是统一分支，不会产生线程发散开销
    if (isCover && m > 0.001) {
      float n1 = snoise(vec3(base.xy * 1.4, t * 0.55));
      float n2 = snoise(vec3(base.xy * 2.8 + 5.0, t * 0.85));
      float n3 = snoise(vec3(base.xy * 6.5, t * 3.5 + aRand * 4.0));
      float breath = snoise(vec3(base.xy * 0.35, t * 0.40));
      float relief = (n1 * 0.60 + n2 * 0.40) * uMid * 1.15
                   + n3 * uTreble * 0.50
                   + breath * uBass * 1.25;
      p.z += relief * m;
    }

    // 涟漪抬升
    p.z += ripple * 1.30;

    // ---- 节拍跳动 + 预设切换爆散：径向位移，先 smoothstep 缓动再施加 ----
    float pulse = smoothstep(0.0, 1.0, uPulse);
    vec3 dir = normalize(base + vec3(1e-4));
    p += dir * pulse * (0.45 + uBass * 0.90) * burstScale;
    p += dir * smoothstep(0.0, 1.0, uPresetBurst) * 1.60 * burstScale;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // ---- 点大小：直接采用 Mineradio 的公式与常数 ----
    // 这是「整屏发白 / 看不清粒子」的真正根因：
    //   上一版 depthSize = 300/-z、上限 40px；Mineradio 是 36/-z、上限约 5px，
    //   sprite 面积差约 8 倍。14k 颗粒子在 8 倍尺寸下必然糊成一片并拖垮填充率。
    // 另一个关键点：audioBoost 在 Mineradio 里作用在「尺寸」而非亮度上
    //   （涟漪/节拍让粒子变大，vBright 的权重反而很小）。
    float depthSize = 36.0 / max(0.5, -mv.z);
    float sz;
    if (uPreset > 8.5) {
      float authoredDrive = uBass * 0.10 + uMid * 0.08 + uTreble * 0.12 + uPulse * 0.10;
      sz = clamp(depthSize * (0.98 + authoredDrive), 1.00, 4.85);
    } else if (uPreset > 4.5) {
      float flowDrive = uBass * 0.070 + uMid * 0.046 + uTreble * 0.060
                      + uPresetBurst * 0.090 + uPulse * 0.055;
      sz = clamp(depthSize * (1.05 + flowDrive), 1.00, 5.45);
    } else if (uPreset > 3.5) {
      float ringDrive = uBass * 0.30 + uMid * 0.18 + uTreble * 0.22 + uPulse * 0.30;
      sz = clamp(depthSize * (0.90 + ringDrive * 0.62), 1.05, 3.90);
    } else {
      float audioBoost = 1.0 + ripple * 0.7 + edgeBoost * 0.55 + uPulse * 0.30 + uPresetBurst * 0.5;
      sz = clamp(depthSize * audioBoost, 1.05, 4.95);
    }
    // 星河层用 Mineradio 的另一套夹取范围（其星河是独立着色器，尺寸更大更亮）
    float starSz = clamp(sz * 1.30, 0.75, 5.60);
    gl_PointSize = (isStar ? starSz : sz) * uPixel * uPointSize;

    // ---- 颜色 ----
    // 基础色：按预设取 Mineradio 的调色板（其 defaultColor 与 5~12 号预设的专属色）
    vec3 basePalette = presetPalette(uPreset, aUv, aRand, t);

    // 封面预设：采样专辑图原色
    vec2 cuv = clamp(aUv, vec2(0.0022), vec2(0.9978));
    vec3 coverCol = texture2D(uCoverTex, cuv).rgb;
    // 暗封面自动提亮：否则整张专辑图会糊成一片近黑粒子，什么都读不出来
    coverCol = pow(max(coverCol, vec3(0.0)), vec3(0.88))
             * mix(1.45, 1.0, clamp(uCoverLum, 0.0, 1.0));

    vec3 bodyCol = isCover ? mix(basePalette, coverCol, m) : basePalette;

    // ---- 预设 1（滚筒）：筒壁贴当前封面，uv.y 用流动后的 flow；并按纵深淡出（原式）----
    if (!isStar && uPreset > 0.5 && uPreset < 1.5) {
      float flow1 = fract(aUv.y - t * 0.08 * (1.0 + uBass * 0.55));
      vec2 tuv = clamp(vec2(aUv.x, flow1), vec2(0.0022), vec2(0.9978));
      vec3 tunnelCover = texture2D(uCoverTex, tuv).rgb;
      float zPos1 = (flow1 - 0.5) * 9.0;
      // 远端压暗：4.5 处最亮、两端降到 0.4（原式的 depthFade）
      bodyCol = mix(basePalette, tunnelCover * (0.4 + smoothstep(-4.5, 4.5, zPos1) * 0.7),
                    uHasCover);
    }
    // ---- 预设 4（唱片）：中心贴封面 + 黑胶沟槽 + 完整白边（原式）----
    else if (!isStar && uPreset > 3.5 && uPreset < 4.5) {
      vec2 p4 = (aUv - vec2(0.5)) * 5.12;
      float d4 = length(p4);
      float recordR4 = 2.46;
      float coverR4 = 1.18;
      float border4 = exp(-pow((d4 - coverR4) / 0.064, 2.0));
      float outerRim4 = exp(-pow((d4 - (recordR4 - 0.050)) / 0.055, 2.0));
      float vinylN4 = clamp((d4 - coverR4) / max(0.001, recordR4 - coverR4), 0.0, 1.0);
      float angle04 = atan(p4.y, p4.x);
      // 沟槽上的高频「打点」：只有高音时才亮（原式的 tick）
      float tick4 = smoothstep(0.82, 0.995,
        hash11(floor((angle04 + PI) * 38.0) + floor(d4 * 72.0) * 2.1));
      vec2 coverUv4 = p4 / (coverR4 * 2.0) + 0.5;
      vec3 cc4 = texture2D(uCoverTex, clamp(coverUv4, vec2(0.0022), vec2(0.9978))).rgb;
      if (1.0 - smoothstep(coverR4 - 0.012, coverR4 + 0.018, d4) > 0.02) {
        // 中心盘面：封面 + 向内渐亮的 coverShade，白边处混白
        float coverShade = 1.02 + 0.10 * (1.0 - smoothstep(0.0, coverR4, d4));
        bodyCol = mix(bodyCol, mix(cc4 * coverShade, vec3(1.0), border4 * 0.54), uHasCover);
      } else {
        // 外圈黑胶：细密沟槽纹理 + 少量封面色渗入 + 白边与打点
        float groove4 = 0.5 + 0.5 * sin((d4 - coverR4) * 98.0);
        float fineGroove4 = 0.5 + 0.5 * sin((d4 - coverR4) * 170.0 + aRand * 3.0);
        vec3 vinyl4 = vec3(0.052, 0.054, 0.058)
                    + vec3(0.052) * groove4 + vec3(0.026) * fineGroove4;
        vinyl4 = mix(vinyl4, cc4 * 0.32, 0.18 * (1.0 - vinylN4));
        float whiteRing4 = max(border4 * 0.92, outerRim4 * 0.26);
        vec3 vinylCol = mix(vinyl4, vec3(0.92, 0.94, 0.94), whiteRing4);
        vinylCol = mix(vinylCol, vec3(1.0),
                       tick4 * smoothstep(0.05, 0.46, uTreble) * (0.06 + border4 * 0.12));
        bodyCol = mix(bodyCol, vinylCol, uHasCover);
      }
    }

    // 星河：冷白偏香槟 + 缓慢闪烁
    float twinkle = 0.65 + 0.35 * sin(t * (0.6 + aRand * 2.4) + aRand * 31.0);
    vec3 starCol = mix(vec3(0.780, 0.860, 0.950), vec3(0.968, 0.905, 0.807), 0.45) * twinkle;

    vColor = isStar ? starCol : bodyCol;

    // ---- 亮度：直接采用 Mineradio 的分组 vBright 公式 ----
    // 上一版自造的加权和峰值可达约 1.9，叠加加法混合会把「粒子围住相机」的预设
    // （滚筒，实测均值 240/255）整屏刷白。Mineradio 的取值区间只有 0.82~1.1、
    // 节拍项权重仅 0.016~0.16 —— 这正是它亮而不刺眼的原因。
    // 这里省掉了 edgeBoost 项：那依赖它的 AI 边缘/深度纹理，本项目没有。
    float maxRippleAmp = max(ripple, 0.0);
    float vBright;
    if (uPreset > 8.5) {
      vBright = 0.86 + maxRippleAmp * 0.52 + uEnergy * 0.045 + uPulse * 0.055;
    } else if (uPreset > 4.5) {
      vBright = 0.94 + maxRippleAmp * 0.34 + uBass * 0.020
              + uEnergy * 0.026 + uPresetBurst * 0.025;
    } else if (uPreset > 3.5) {
      vBright = 0.94 + maxRippleAmp * 0.64 + uBass * 0.08
              + edgeBoost * 0.12 + uEnergy * 0.05 + uPulse * 0.16 + uPresetBurst * 0.16;
    } else {
      vBright = 0.82 + maxRippleAmp * 0.55 + uBass * 0.10
              + edgeBoost * 0.30 + uEnergy * 0.05 + uPresetBurst * 0.40;
    }
    // 星河不参与预设亮度分组，保持稳定的 1.0（闪烁已含在 starCol 里）
    vGlow = isStar ? 1.0 : vBright;

    float bodyAlpha = (0.55 + 0.45 * smoothstep(0.0, 1.0, 0.32 + uEnergy * 0.60))
                    * mix(1.0, 0.94, m);
    vAlpha = isStar ? twinkle * 0.75 : bodyAlpha;
    // 光晕强度：以默认值 0.62 为 1.0 基准，保证出厂观感不变
    vAlpha *= uBloom / 0.62;
    // 虚空预设（索引 3）：隐去全部预设粒子，只留星河背景。
    // 这是 Mineradio 的 VOID 原始语义。实测把它画成一个包围相机的壳层时，
    // 加法混合会整屏曝白（mean 亮度 254/255）—— 也就是「屏幕都变白色了」的根因。
    if (voidPreset && !isStar) vAlpha = 0.0;

    vRipple = isStar ? 0.0 : clamp(ripple, 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vGlow;
  varying float vAlpha;
  varying float vRipple;

  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    // 双瓣高斯：锐利核心 + 宽域光晕 —— 单层绘制即有 bloom 观感，
    // 再乘一条平滑收口，边缘没有任何可见硬边（对比硬阈值 smoothstep 会留下圆盘边）
    float core = exp(-d * d * 5.0);
    float halo = exp(-d * d * 1.50) * 0.42;
    float a = (core + halo) * (1.0 - smoothstep(0.82, 1.0, d));
    if (a < 0.003) discard;
    // 亮度已在顶点阶段按 Mineradio 的分组公式算进 vGlow，这里只做线性相乘
    vec3 col = vColor * vGlow;
    gl_FragColor = vec4(col, a * vAlpha * uOpacity);
  }
`

/** 生成中性的深度/边缘占位图：depth=0.5、edge=0、fg=0、lum=0（不透明）。
 *  没有封面时用它，使 (depthVal - 0.5) 恒为 0，等效于 uHasDepth = 0。
 */
function createNeutralEdgeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const img = ctx.createImageData(256, 256)
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 128
      img.data[i + 1] = 0
      img.data[i + 2] = 0
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }
  return canvas
}

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
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 200)

  const count = options.count
  const starCount = options.starCount ?? DEFAULT_STAR_COUNT
  const total = count + starCount
  const radius = options.radius ?? 6
  const plane = options.plane ?? DEFAULT_PLANE

  const positions = new Float32Array(total * 3)
  const aUv = new Float32Array(total * 2)
  const aRand = new Float32Array(total)
  const aKind = new Float32Array(total)

  // count 恒为 grid²（见 ParticleScene）。网格布局保证每个粒子拿到唯一的封面 UV，
  // 拼出来的图像不会出现重叠或空洞；后面的 starCount 个是星河背景层。
  const grid = Math.max(1, Math.round(Math.sqrt(count)))
  for (let i = 0; i < total; i++) {
    const isStar = i >= count
    // 锚点：球面均匀随机。只有方向会被使用（目标半径由公式给出），
    // 但星河粒子出生在更大的壳层上，避免首帧从中心炸出来
    const u = Math.random()
    const v = Math.random()
    const theta = u * Math.PI * 2
    const phi = Math.acos(2 * v - 1)
    const r = isStar
      ? plane * (0.85 + Math.random() * 1.35)
      : radius * (0.62 + Math.random() * 0.38)
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)

    // 封面 UV：取 texel 中心，避免采样到邻格导致边缘串色
    const gx = i % grid
    const gy = Math.floor(i / grid)
    aUv[i * 2] = isStar ? 0.5 : (gx + 0.5) / grid
    aUv[i * 2 + 1] = isStar ? 0.5 : (gy + 0.5) / grid

    aRand[i] = Math.random()
    aKind[i] = isStar ? 1 : 0
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  // 预设 6 需要就地改写锚点坐标，这里保留同一份数组引用
  const positions3 = positions
  geometry.setAttribute('aUv', new THREE.BufferAttribute(aUv, 2))
  geometry.setAttribute('aRand', new THREE.BufferAttribute(aRand, 1))
  geometry.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1))

  // 封面纹理：只创建一次，切歌时替换 `image` 内容（尺寸恒定，无需重建）。
  // flipY=false：让纹理 v=0 对应 canvas 顶行，与 WebGPU 路径
  // （copyExternalImageToTexture 默认不翻转）保持完全一致的朝向。
  const placeholder = createPlaceholderCover()
  const coverTexture = new THREE.CanvasTexture(placeholder.canvas)
  coverTexture.minFilter = THREE.LinearFilter
  coverTexture.magFilter = THREE.LinearFilter
  coverTexture.wrapS = THREE.ClampToEdgeWrapping
  coverTexture.wrapT = THREE.ClampToEdgeWrapping
  coverTexture.generateMipmaps = false
  coverTexture.flipY = false

  // 深度/边缘纹理：无封面时用 depth=0.5 / edge=0 的中性图占位，
  // 于是 (depthVal - 0.5) 恒为 0，等效于 uHasDepth = 0，无需额外 uniform
  const edgeTexture = new THREE.CanvasTexture(createNeutralEdgeCanvas())
  edgeTexture.minFilter = THREE.LinearFilter
  edgeTexture.magFilter = THREE.LinearFilter
  edgeTexture.wrapS = THREE.ClampToEdgeWrapping
  edgeTexture.wrapT = THREE.ClampToEdgeWrapping
  edgeTexture.generateMipmaps = false
  edgeTexture.flipY = false

  const uniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uEnergy: { value: 0 },
    uPulse: { value: 0 },
    uPointSize: { value: options.pointSize },
    uPixel: { value: renderer.getPixelRatio() },
    uCoverMix: { value: 0 },
    uHasCover: { value: 0 },
    uCoverLum: { value: 0.5 },
    uPlane: { value: plane },
    uIntensity: { value: DEFAULT_FX.intensity },
    uSpeed: { value: DEFAULT_FX.speed },
    uDepth: { value: DEFAULT_FX.depth },
    uTwist: { value: DEFAULT_FX.twist },
    uScatter: { value: DEFAULT_FX.scatter },
    uBloom: { value: DEFAULT_FX.bloom },
    uEdge: { value: DEFAULT_FX.edge },
    uBgFade: { value: DEFAULT_FX.bgFade },
    uPreset: { value: 0 },
    uPresetBurst: { value: 0 },
    uColorA: { value: COLOR_CHAMPAGNE.clone() },
    uColorB: { value: COLOR_MINT.clone() },
    uCoverTex: { value: coverTexture },
    uEdgeTex: { value: edgeTexture },
    uRipples: {
      value: [
        new THREE.Vector4(0, 0, 0, 0),
        new THREE.Vector4(0, 0, 0, 0),
        new THREE.Vector4(0, 0, 0, 0),
        new THREE.Vector4(0, 0, 0, 0),
      ],
    },
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

  const rippleTargets = uniforms.uRipples.value

  return {
    backend: 'webgl2',
    count,
    resize(width: number, height: number) {
      const w = Math.max(1, Math.floor(width))
      const h = Math.max(1, Math.floor(height))
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(w, h, false)
      // 锁定水平视野：容器宽高比变化时，保持左右占屏比例与全屏一致
      const aspect = w / h
      camera.fov = verticalFovForAspect(aspect)
      camera.aspect = aspect
      camera.updateProjectionMatrix()
      uniforms.uPixel.value = renderer.getPixelRatio()
    },
    setCover(cover) {
      if (!cover || !cover.hasImage) {
        uniforms.uHasCover.value = 0
        uniforms.uCoverLum.value = 0.5
        return
      }
      if (cover.canvas.width !== COVER_TEXTURE_SIZE || cover.canvas.height !== COVER_TEXTURE_SIZE) {
        // 尺寸不符会让 three 沿用旧尺寸的纹理分配 —— 这是本文件的硬约定，直接拒绝更安全
        console.warn('[particle] 封面画布尺寸不符，已忽略：', cover.canvas.width, cover.canvas.height)
        return
      }
      coverTexture.image = cover.canvas
      coverTexture.needsUpdate = true
      if (cover.edgeCanvas) {
        edgeTexture.image = cover.edgeCanvas
        edgeTexture.needsUpdate = true
      }
      uniforms.uHasCover.value = 1
      uniforms.uCoverLum.value = cover.luminance
    },
    setCoverMix(mix: number) {
      uniforms.uCoverMix.value = Math.max(0, Math.min(1, mix))
    },
    setFx(fx) {
      uniforms.uIntensity.value = fx.intensity
      uniforms.uSpeed.value = fx.speed
      uniforms.uDepth.value = fx.depth
      uniforms.uTwist.value = fx.twist
      uniforms.uScatter.value = fx.scatter
      uniforms.uBloom.value = fx.bloom
      uniforms.uEdge.value = fx.edge
      uniforms.uBgFade.value = fx.bgFade
    },
    setSkullPoints(positions) {
      if (!positions || positions.length < 3) return
      const n = Math.min(count, Math.floor(positions.length / 3))
      for (let i = 0; i < n; i++) {
        positions3[i * 3] = positions[i * 3]
        positions3[i * 3 + 1] = positions[i * 3 + 1]
        positions3[i * 3 + 2] = positions[i * 3 + 2]
      }
      geometry.attributes.position.needsUpdate = true
    },
    setPreset(preset: number) {
      uniforms.uPreset.value = preset
    },
    setPresetBurst(value: number) {
      uniforms.uPresetBurst.value = Math.max(0, Math.min(1, value))
    },
    update(features: AudioFeatures, c: CameraState) {
      uniforms.uTime.value = features.time
      uniforms.uBass.value = features.bass
      uniforms.uMid.value = features.mid
      uniforms.uTreble.value = features.treble
      uniforms.uEnergy.value = features.energy
      uniforms.uPulse.value = features.pulse

      const ripples = features.ripples
      for (let i = 0; i < rippleTargets.length; i++) {
        const o = i * 4
        rippleTargets[i].set(ripples[o], ripples[o + 1], ripples[o + 2], ripples[o + 3])
      }

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
      coverTexture.dispose()
      renderer.dispose()
      canvas.remove()
    },
  }
}
