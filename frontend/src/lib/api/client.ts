/**
 * 前端 API 客户端封装
 * 统一处理 /api/* 的 GET/POST/PATCH/DELETE，自动解析 ApiResponse<T>。
 */

import type { ApiResponse } from '@/lib/types/music'

function buildQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return ''
  const pairs: [string, string][] = []
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') pairs.push([k, String(v)])
  }
  if (pairs.length === 0) return ''
  return '?' + new URLSearchParams(pairs).toString()
}

async function parseJson<T>(res: Response): Promise<T> {
  // 检查 HTTP 状态码
  if (!res.ok) {
    // 尝试读取响应文本以诊断问题
    const text = await res.text().catch(() => '')
    const contentType = res.headers.get('content-type') || ''
    // 如果不是 JSON 响应，直接抛出更友好的错误
    if (!contentType.includes('application/json')) {
      throw new Error(`HTTP ${res.status} ${res.statusText}（响应类型: ${contentType}，内容: ${text.slice(0, 200)}）`)
    }
    try {
      const json = await JSON.parse(text)
      throw new Error(json.error?.message || `HTTP ${res.status}`)
    } catch (e) {
      throw new Error(`HTTP ${res.status}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  let json: ApiResponse<T>
  try {
    json = await res.json()
  } catch (e) {
    // JSON 解析失败，读取文本以便调试
    const text = await res.text().catch(() => '')
    throw new Error(`JSON.parse: ${e instanceof Error ? e.message : String(e)}\n响应前 200 字符: ${text.slice(0, 200)}`)
  }

  if (!json.success || json.data === undefined) {
    throw new Error(json.error?.message || '请求失败')
  }
  return json.data
}

export async function apiGet<T>(
  url: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const res = await fetch(`/api/${url}${buildQuery(params)}`)
  return parseJson<T>(res)
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${url}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${url}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return parseJson<T>(res)
}

export async function apiDelete<T>(
  url: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const res = await fetch(`/api/${url}${buildQuery(params)}`, { method: 'DELETE' })
  return parseJson<T>(res)
}
