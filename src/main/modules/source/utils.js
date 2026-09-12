const zlib = require('zlib')

let userApis = []
let scripts = new Map()

const saveData = () => {
  const fs = require('fs')
  const dataPath = process.env.DATA_PATH || './data'
  const configPath = require('path').join(dataPath, 'config', 'sources.json')
  const configDir = require('path').dirname(configPath)
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  
  const exportData = userApis.map(api => ({
    ...api,
    script: scripts.get(api.id) || ''
  }))
  fs.writeFileSync(configPath, JSON.stringify(exportData, null, 2))
}

const loadConfig = () => {
  const fs = require('fs')
  const path = require('path')
  const dataPath = process.env.DATA_PATH || './data'
  const configPath = path.join(dataPath, 'config', 'sources.json')
  
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      userApis = data || []
      data.forEach(api => {
        if (api.script) {
          scripts.set(api.id, api.script)
        }
      })
    } catch (e) {
      console.error('Failed to load config:', e.message)
    }
  }
}

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

const deflateScript = async(script) => {
  return new Promise((resolve, reject) => {
    zlib.deflate(Buffer.from(script, 'utf8'), (err, buf) => {
      if (err) reject(err)
      else resolve('gz_' + buf.toString('base64'))
    })
  })
}

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

const getUserApis = () => userApis

const importApi = async(scriptRaw) => {
  let scriptInfo = parseScriptInfo(scriptRaw)
  const script = await deflateScript(scriptRaw)
  
  for (const api of userApis) {
    const existingScript = scripts.get(api.id)
    if (existingScript === script) {
      throw new Error(`Duplicate source: ${api.name}`)
    }
  }
  
  const apiInfo = {
    id: `source_${Math.random().toString(36).substring(2, 8)}_${Date.now()}`,
    ...scriptInfo,
    allowShowUpdateAlert: true,
  }
  
  userApis.push(apiInfo)
  scripts.set(apiInfo.id, script)
  saveData()
  return apiInfo
}

const removeApi = (ids) => {
  userApis = userApis.filter(api => !ids.includes(api.id))
  ids.forEach(id => scripts.delete(id))
  saveData()
  return userApis
}

const getScript = async(id) => {
  return inflateScript(scripts.get(id) || '')
}

module.exports = {
  loadConfig,
  getUserApis,
  importApi,
  removeApi,
  getScript,
}
