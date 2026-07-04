import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig(({ command }) => {
  return {
    base: command === 'serve' ? '/' : '/black-hole/',
    server: {
      host: '127.0.0.1',
    },
    preview: {
      host: '127.0.0.1',
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          webgpu: resolve(__dirname, 'webgpu.html'),
        },
      },
    },
  }
})

