import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { registerServiceWorker } from './app/pwa.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
registerServiceWorker()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
