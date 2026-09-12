const express = require('express')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const app = express()
// 容器内监听端口（与 docker-compose 的端口映射右侧保持一致）
const PORT = process.env.PORT || 3000
// 数据目录：音源配置持久化为 ${DATA_DIR}/sources.json
const DATA_DIR = process.env.DATA_DIR || '/app/config'
const SOURCES_FILE = path.join(DATA_DIR, 'sources.json')

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// 存储音源数据
let sources = []
try {
  if (fs.existsSync(SOURCES_FILE)) {
    sources = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'))
  }
} catch (e) {
  console.error('Failed to load sources:', e.message)
}

// 保存数据
const saveData = () => {
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2))
}

// 解析脚本信息
const parseScriptInfo = (script) => {
  const result = /^\/\*[\S|\s]+?\*\//.exec(script)
  if (!result) throw new Error('Invalid source script')
  
  const infoArr = result[0].split(/\r?\n/)
  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/
  const infos = {}
  
  for (const info of infoArr) {
    const match = rxp.exec(info)
    if (match) {
      infos[match[1]] = match[2].trim()
    }
  }
  
  infos.name ||= `source_${Date.now()}`
  return infos
}

// 压缩脚本
const deflateScript = async(script) => {
  return new Promise((resolve, reject) => {
    zlib.deflate(Buffer.from(script, 'utf8'), (err, buf) => {
      if (err) reject(err)
      else resolve('gz_' + buf.toString('base64'))
    })
  })
}

// 解压脚本
const inflateScript = async(script) => {
  if (script.startsWith('gz_')) {
    return new Promise((resolve, reject) => {
      zlib.inflate(Buffer.from(script.substring(3), 'base64'), (err, buf) => {
        if (err) reject(err)
        else resolve(buf.toString('utf8'))
      })
    })
  }
  return script
}

// 中间件
app.use(express.json())
app.use(express.static(path.join(__dirname, '../renderer')))

// API 路由
app.get('/api/sources', (req, res) => {
  res.json(sources.map(s => ({ ...s, script: undefined })))
})

app.post('/api/sources', async (req, res) => {
  try {
    const { script } = req.body
    const info = parseScriptInfo(script)
    const compressed = await deflateScript(script)
    
    const newSource = {
      id: `source_${Math.random().toString(36).substring(2, 8)}_${Date.now()}`,
      ...info,
      script: compressed,
      allowShowUpdateAlert: true,
    }
    
    sources.push(newSource)
    saveData()
    res.json({ success: true, apiInfo: { ...newSource, script: undefined } })
  } catch (e) {
    res.status(400).json({ success: false, error: e.message })
  }
})

app.delete('/api/sources', (req, res) => {
  const { ids } = req.body
  sources = sources.filter(s => !ids.includes(s.id))
  saveData()
  res.json(sources.map(s => ({ ...s, script: undefined })))
})

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// 启动服务器
app.listen(PORT, () => {
  console.log(`HollyMudic server running on port ${PORT}`)
})

module.exports = app
