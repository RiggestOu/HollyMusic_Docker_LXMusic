#!/usr/bin/env python3
"""
粒子着色器验证脚本 —— 在真实浏览器里编译两条渲染后端的着色器。

# 为什么需要它
GLSL / WGSL 的编译错误对 TypeScript 完全不可见，且失败方式是「静默黑屏」：
  · WebGL 2.0：着色器编译失败 → three 抛错 → 场景全黑；
  · WebGPU：WGSL 编译错误是**异步**上报的，同步的 createComputePipeline() 不会抛错，
    只会产出一个坏管线，同样表现为全黑。
因此每次改动 lib/client/particle/*.ts 里的着色器后，都应该跑一次本脚本，
而不是靠人眼审阅。

# 它做什么
1. 从 `lib/client/particle/webgl2.ts` 抽出 VERTEX_SHADER / FRAGMENT_SHADER 原文，
   拼上 three 对 ShaderMaterial 注入的标准前缀，交给真实 WebGL2 上下文
   编译 + 链接，并核对每个期望的 uniform / attribute 在链接后确实存在
   （漏声明 uniform 是这类着色器最常见的静默错误）。
2. 从 `lib/client/particle/webgpu.ts` 抽出 WGSL 原文，在支持 WebGPU 的浏览器里
   走 getCompilationInfo() + createComputePipelineAsync/createRenderPipelineAsync，
   把异步错误变成可见结论。

# 用法
    # 需要系统可用的 Chromium 内核浏览器（Edge / Chrome）。默认自动查找 Edge。
    python scripts/verify-particle-shaders.py

    # 指定浏览器
    python scripts/verify-particle-shaders.py --browser "C:\\path\\to\\chrome.exe"

退出码 0 = 全部通过；1 = 有失败项。无头环境拿不到 WebGPU adapter 时会标记为「跳过」
（此时请改用下面的静态校验，或在本机有 GPU 的浏览器里手动打开生成的 HTML）。

# 补充：WGSL 静态校验（无 GPU 环境下的兜底）
若需要一个不依赖 GPU 的 WGSL 校验（语法解析 + 结构体内存布局 + 绑定顺序 +
「顶点阶段不得使用 textureSample」等阶段规则），可使用 wgsl_reflect 版的脚本。
它与本脚本互补：本脚本验证「真机能不能编译过」，静态校验验证「布局对不对」。
存放位置见项目记忆中的「粒子着色器验证」条目。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>粒子着色器验证</title></head>
<body>
<div id="result">PENDING</div>
<script type="module">
const VERTEX_SHADER = %(vertex)s;
const FRAGMENT_SHADER = %(fragment)s;
const WGSL = %(wgsl)s;

const report = { glsl: null, wgsl: null, errors: [] };

// ---------- 1. GLSL：真实 WebGL2 上下文编译 + 链接 ----------
function checkGLSL() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const gl = canvas.getContext('webgl2');
  if (!gl) return { ok: false, detail: 'WebGL2 上下文不可用' };

  // 还原 three 注入 ShaderMaterial 的前缀（内建 attribute / uniform / precision）
  const VERT_PREFIX = [
    'precision highp float;', 'precision highp int;',
    'uniform mat4 modelMatrix;', 'uniform mat4 modelViewMatrix;',
    'uniform mat4 projectionMatrix;', 'uniform mat4 viewMatrix;',
    'uniform mat3 normalMatrix;', 'uniform vec3 cameraPosition;',
    'uniform bool isOrthographic;',
    'attribute vec3 position;', 'attribute vec3 normal;', 'attribute vec2 uv;', '',
  ].join('\\n');
  const FRAG_PREFIX = [
    'precision highp float;', 'precision highp int;',
    'uniform mat4 viewMatrix;', 'uniform vec3 cameraPosition;',
    'uniform bool isOrthographic;', '',
  ].join('\\n');

  const compile = (type, source, label) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      return { shader: null, error: label + ': ' + gl.getShaderInfoLog(sh) };
    }
    return { shader: sh, error: null };
  };

  const v = compile(gl.VERTEX_SHADER, VERT_PREFIX + VERTEX_SHADER, 'vertex');
  const f = compile(gl.FRAGMENT_SHADER, FRAG_PREFIX + FRAGMENT_SHADER, 'fragment');
  const errors = [v.error, f.error].filter(Boolean);
  if (errors.length) return { ok: false, detail: errors.join(' | ') };

  const prog = gl.createProgram();
  gl.attachShader(prog, v.shader);
  gl.attachShader(prog, f.shader);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    return { ok: false, detail: 'link: ' + gl.getProgramInfoLog(prog) };
  }

  const expectedUniforms = ['uTime','uBass','uMid','uTreble','uEnergy','uPulse','uPointSize',
    'uPixel','uCoverMix','uHasCover','uPlane','uCoverLum','uColorA','uColorB',
    'uCoverTex','uRipples','uOpacity','uPreset','uPresetBurst'];
  const missingUniforms = expectedUniforms.filter(n =>
    gl.getUniformLocation(prog, n) === null && gl.getUniformLocation(prog, n + '[0]') === null);
  if (missingUniforms.length) {
    return { ok: false, detail: '缺少 uniform: ' + missingUniforms.join(',') };
  }

  // aScale 已随「点大小对齐 Mineradio」而不再被着色器使用（被编译器优化掉），故不再断言
  const missingAttribs = ['aUv', 'aRand', 'aKind'].filter(
    n => gl.getAttribLocation(prog, n) < 0);
  if (missingAttribs.length) {
    return { ok: false, detail: '缺少 attribute: ' + missingAttribs.join(',') };
  }

  // 真实赋一次值，确认 uRipples 这类数组被优化后不会出现空指针
  const loc = gl.getUniformLocation(prog, 'uRipples[0]');
  if (loc) gl.uniform4f(loc, -1, 0, 0, 0);

  return {
    ok: true,
    detail: 'GLSL 编译 + 链接 + uniform/attribute 校验通过',
    renderer: gl.getParameter(gl.RENDERER),
  };
}

// ---------- 2. WGSL：真实 WebGPU 编译诊断 + 管线创建 ----------
async function checkWGSL() {
  if (!navigator.gpu) return { ok: false, skipped: true, detail: 'navigator.gpu 不可用（已跳过）' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, skipped: true, detail: 'adapter 不可用（已跳过）' };
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: WGSL });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(m => m.type === 'error');
    if (errors.length) {
      return { ok: false, detail: errors.map(e => e.lineNum + ':' + e.linePos + ' ' + e.message).join(' | ') };
    }
    const warnings = info.messages.filter(m => m.type === 'warning');
    // auto layout 推导失败只有到真实管线创建才会暴露
    await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'cs_main' } });
    await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
      primitive: { topology: 'triangle-list' },
    });
    return { ok: true, detail: 'WGSL 编译 + compute/render 管线创建通过（warning ' + warnings.length + ' 条）' };
  } catch (e) {
    return { ok: false, detail: 'WGSL 校验抛错: ' + (e && e.message ? e.message : String(e)) };
  }
}

(async () => {
  const el = document.getElementById('result');
  const flush = () => { el.textContent = 'SMOKE_RESULT=' + JSON.stringify(report); };

  try { report.glsl = checkGLSL(); } catch (e) { report.errors.push('GLSL 异常: ' + e); }
  flush(); // 先落一次：即便 WebGPU 探测挂住，GLSL 结论也不会丢

  // 无 GPU 环境下 requestAdapter 可能永不 resolve，必须加超时
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise(res => setTimeout(
      () => res({ ok: false, skipped: true, detail: label + ' 超时 ' + ms + 'ms（无可用 GPU，已跳过）' }),
      ms)),
  ]);

  try { report.wgsl = await withTimeout(checkWGSL(), 12000, 'WGSL 校验'); }
  catch (e) { report.errors.push('WGSL 异常: ' + e); }
  flush();
  document.title = 'DONE';
})();
</script>
</body>
</html>
"""


def extract_shader(source: str, name: str) -> str:
    """抽出 `const NAME = /* lang */ \\`...\\`` 里的模板字符串内容。"""
    m = re.search(r"const " + name + r" = /\* \w+ \*/ `(.*?)\n`", source, re.S)
    if not m:
        raise SystemExit(f"无法从源文件抽取 {name}")
    body = m.group(1)
    # 还原模板插值（webgl2.ts 用 ${RIPPLE_LIFE.toFixed(1)} 注入涟漪寿命）
    body = re.sub(r"\$\{RIPPLE_LIFE\.toFixed\(1\)\}", "2.0", body)
    return body.replace("\\`", "`").replace("\\${", "${")


def find_browser(explicit: str | None) -> str:
    if explicit:
        if not os.path.exists(explicit):
            raise SystemExit(f"指定的浏览器不存在：{explicit}")
        return explicit
    for path in BROWSER_CANDIDATES:
        if os.path.exists(path):
            return path
    raise SystemExit("未找到 Chromium 内核浏览器，请用 --browser 指定路径")


def main() -> int:
    parser = argparse.ArgumentParser(description="验证粒子渲染两条后端的着色器")
    parser.add_argument("--browser", help="Chromium 内核浏览器可执行文件路径")
    parser.add_argument("--keep", action="store_true", help="保留生成的临时 HTML 便于手动排查")
    args = parser.parse_args()

    glsl_src = (PROJECT_ROOT / "lib/client/particle/webgl2.ts").read_text(encoding="utf-8")
    wgsl_src = (PROJECT_ROOT / "lib/client/particle/webgpu.ts").read_text(encoding="utf-8")

    vertex = extract_shader(glsl_src, "VERTEX_SHADER")
    fragment = extract_shader(glsl_src, "FRAGMENT_SHADER")
    wgsl = extract_shader(wgsl_src, "WGSL")

    work_dir = Path(tempfile.mkdtemp(prefix="hm-particle-verify-"))
    html_path = work_dir / "index.html"
    html_path.write_text(
        PAGE_TEMPLATE % {
            "vertex": json.dumps(vertex),
            "fragment": json.dumps(fragment),
            "wgsl": json.dumps(wgsl),
        },
        encoding="utf-8",
    )

    print(f"着色器规模：vertex {vertex.count(chr(10)) + 1} 行 / "
          f"fragment {fragment.count(chr(10)) + 1} 行 / "
          f"WGSL {wgsl.count(chr(10)) + 1} 行")

    browser = find_browser(args.browser)
    cmd = [
        browser,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-data-dir={work_dir / 'profile'}",
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--virtual-time-budget=25000",
        "--dump-dom",
        html_path.as_uri(),
    ]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    except subprocess.TimeoutExpired:
        print("FAIL 浏览器执行超时")
        return 1

    marks = re.findall(r"SMOKE_RESULT=(\{.*?\})</div>", proc.stdout, re.S)
    if not marks:
        print("FAIL 未取到验证结果（页面未执行完成？）")
        print(proc.stdout[:2000])
        return 1

    report = json.loads(marks[-1])
    gl = report.get("glsl") or {}
    wg = report.get("wgsl") or {}

    failures = 0
    print()
    if gl.get("ok"):
        print(f"  ok   GLSL：{gl.get('detail')}")
        print(f"       渲染器：{gl.get('renderer')}")
    else:
        failures += 1
        print(f"  FAIL GLSL：{gl.get('detail')}")

    if wg.get("skipped"):
        print(f"  skip WGSL：{wg.get('detail')}")
    elif wg.get("ok"):
        print(f"  ok   WGSL：{wg.get('detail')}")
    else:
        failures += 1
        print(f"  FAIL WGSL：{wg.get('detail')}")

    if report.get("errors"):
        failures += 1
        print(f"  FAIL 其它异常：{report['errors']}")

    print()
    if failures == 0:
        print("RESULT=OK")
    else:
        print(f"RESULT=FAIL 共 {failures} 项")

    if args.keep:
        print(f"临时文件保留在：{work_dir}")
    else:
        shutil.rmtree(work_dir, ignore_errors=True)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
