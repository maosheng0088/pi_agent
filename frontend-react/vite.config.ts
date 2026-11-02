import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import {pdfjsAssets} from './pdfjs-assets.ts'
export default defineConfig({plugins:[react(),pdfjsAssets()],server:{port:5174,proxy:{'/api':'http://127.0.0.1:3210'}},build:{emptyOutDir:true}})
