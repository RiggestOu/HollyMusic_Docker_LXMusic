/**
 * 日志管理器
 * 支持不同日志级别，根据环境自动调整
 * 同时写控制台 + 落盘文件（按日期分文件）
 */

import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel
  private isDevelopment: boolean
  private logDir: string

  constructor() {
    this.isDevelopment = process.env.NODE_ENV === 'development'
    // 开发模式显示 DEBUG 日志，生产模式显示 INFO 及以上
    this.level = this.isDevelopment ? LogLevel.DEBUG : LogLevel.INFO
    // 日志目录：优先使用环境变量，否则用 prisma_data 下的 log 目录
    this.logDir = process.env.LOG_DIR || '/app/prisma/prisma/data/log'
  }

  private formatMessage(level: string, message: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString()
    const argsStr = args.length > 0 ? ' ' + args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ') : ''
    return `[${timestamp}] [${level}] ${message}${argsStr}`
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.level
  }

  private getLogFilePath(): string {
    const dateStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    return path.join(this.logDir, `download-${dateStr}.log`)
  }

  private async appendToFile(message: string): Promise<void> {
    try {
      await mkdir(this.logDir, { recursive: true })
      await appendFile(this.getLogFilePath(), message + '\n')
    } catch {
      // 文件写入失败不影响主流程，静默忽略
    }
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      const formatted = this.formatMessage('DEBUG', message, ...args)
      console.log(formatted)
      void this.appendToFile(formatted)
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      const formatted = this.formatMessage('INFO', message, ...args)
      console.log(formatted)
      void this.appendToFile(formatted)
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      const formatted = this.formatMessage('WARN', message, ...args)
      console.warn(formatted)
      void this.appendToFile(formatted)
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      const formatted = this.formatMessage('ERROR', message, ...args)
      console.error(formatted)
      void this.appendToFile(formatted)
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  getLevel(): LogLevel {
    return this.level
  }
}

// 单例实例
export const logger = new Logger()
