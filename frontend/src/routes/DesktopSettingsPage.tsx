/**
 * 桌面端设置页（路由 `/settings`）。
 *
 * 只管理「桌面外壳」自身的设置（服务地址、壁纸 / 歌词开关、粒子渲染参数），
 * 不涉及任何服务端账号与音乐数据——那些仍由 Web 端的管理页面负责。
 */

import { useEffect, useState } from 'react'
import {
  fetchDesktopConfig,
  saveDesktopConfig,
  setLyricsClickThrough,
  isDesktop,
  type DesktopConfig,
} from '@/lib/client/desktop-bridge'
import { desktopInvoke } from '@/lib/client/desktop-bridge'

const DEFAULTS: DesktopConfig = {
  serverUrl: 'http://localhost:3099',
  wallpaperEnabled: false,
  lyricsEnabled: false,
  lyricsClickThrough: true,
  wallpaperPaused: false,
  backend: 'auto',
  grid: 160,
  fps: 60,
  pointSize: 1,
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/10 py-3">
      <div className="min-w-0">
        <div className="text-sm text-white/90">{label}</div>
        {hint ? <div className="mt-0.5 text-xs text-white/45">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function DesktopSettingsPage() {
  const [config, setConfig] = useState<DesktopConfig>(DEFAULTS)
  const [saved, setSaved] = useState(false)
  const [inDesktop] = useState(() => isDesktop())

  useEffect(() => {
    void fetchDesktopConfig().then(c => c && setConfig(c))
  }, [])

  const patch = <K extends keyof DesktopConfig>(key: K, value: DesktopConfig[K]) =>
    setConfig(prev => ({ ...prev, [key]: value }))

  const save = async () => {
    await saveDesktopConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  return (
    <div className="min-h-screen bg-[#0b0b11] px-6 py-8 text-white">
      <div className="mx-auto max-w-xl">
        <h1 className="text-lg font-semibold">HollyMusic 桌面设置</h1>
        <p className="mt-1 text-xs text-white/45">
          {inDesktop
            ? '设置保存在本机，重启客户端后保留。'
            : '当前不在桌面客户端内运行，保存不可用（请通过 HollyMusic Desktop 打开本页）。'}
        </p>

        <div className="mt-6">
          <Row label="服务地址" hint="例如 http://localhost:3099 或你的自部署域名">
            <input
              className="w-64 rounded-md border border-white/15 bg-black/30 px-2 py-1 text-sm"
              value={config.serverUrl}
              onChange={e => patch('serverUrl', e.target.value)}
            />
          </Row>

          <Row label="渲染后端" hint="WebGPU 优先，不支持时自动降级 WebGL 2.0">
            <select
              className="rounded-md border border-white/15 bg-black/30 px-2 py-1 text-sm"
              value={config.backend}
              onChange={e => patch('backend', e.target.value as DesktopConfig['backend'])}
            >
              <option value="auto">自动</option>
              <option value="webgpu">强制 WebGPU</option>
              <option value="webgl2">强制 WebGL 2.0</option>
            </select>
          </Row>

          <Row label="粒子密度" hint={`网格 ${config.grid} × ${config.grid}`}>
            <input
              type="range"
              min={80}
              max={220}
              value={config.grid}
              onChange={e => patch('grid', Number(e.target.value))}
            />
          </Row>

          <Row label="帧率上限" hint={`${config.fps} FPS`}>
            <input
              type="range"
              min={24}
              max={120}
              value={config.fps}
              onChange={e => patch('fps', Number(e.target.value))}
            />
          </Row>

          <Row label="粒子大小" hint={config.pointSize.toFixed(2)}>
            <input
              type="range"
              min={0.4}
              max={2.5}
              step={0.05}
              value={config.pointSize}
              onChange={e => patch('pointSize', Number(e.target.value))}
            />
          </Row>

          <Row label="启动桌面壁纸">
            <input
              type="checkbox"
              checked={config.wallpaperEnabled}
              onChange={e => patch('wallpaperEnabled', e.target.checked)}
            />
          </Row>

          <Row label="启动桌面歌词">
            <input
              type="checkbox"
              checked={config.lyricsEnabled}
              onChange={e => patch('lyricsEnabled', e.target.checked)}
            />
          </Row>

          <Row label="桌面歌词鼠标穿透" hint="开启后不可拖动，需从托盘关闭">
            <input
              type="checkbox"
              checked={config.lyricsClickThrough}
              onChange={e => {
                patch('lyricsClickThrough', e.target.checked)
                setLyricsClickThrough(e.target.checked)
              }}
            />
          </Row>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <button
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            onClick={() => void desktopInvoke('create_wallpaper_window')}
          >
            打开壁纸
          </button>
          <button
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            onClick={() => void desktopInvoke('close_wallpaper_window')}
          >
            关闭壁纸
          </button>
          <button
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            onClick={() => void desktopInvoke('create_lyrics_window')}
          >
            打开歌词
          </button>
          <button
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            onClick={() => void desktopInvoke('close_lyrics_window')}
          >
            关闭歌词
          </button>
          <button
            className="rounded-md bg-[#a8e6cf] px-3 py-1.5 text-sm font-medium text-black"
            onClick={() => void save()}
          >
            {saved ? '已保存' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
