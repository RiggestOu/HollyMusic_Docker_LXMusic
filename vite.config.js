const path = require('path')

module.exports = {
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        server: path.resolve(__dirname, 'src/main/server.js'),
      },
      external: ['electron', 'vue'],
    },
  },
}
