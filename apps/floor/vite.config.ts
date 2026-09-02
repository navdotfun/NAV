import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    // Vendor split (L-11): keep the app chunk lean; big deps cache separately.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/viem/') || id.includes('/@noble/') || id.includes('/abitype/') || id.includes('/ox/')) return 'viem'
          if (id.includes('/chart.js/') || id.includes('/@kurkle/')) return 'charts'
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('mdast') || id.includes('micromark') || id.includes('unified') || id.includes('unist') || id.includes('hast') || id.includes('vfile')) return 'markdown'
          if (id.includes('/react') || id.includes('/scheduler/')) return 'react'
          return 'vendor'
        },
      },
    },
  },
})
