const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 3080
const HTML = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8')

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
})

server.listen(PORT, () => {
  console.log(`Renderer server running on port ${PORT}`)
})

module.exports = server
