import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './conversation-experience.css'
import './workspace-shell.css'
import './scrollbars.css'
import './company-brand.css'
import {installScrollbarVisibility} from './lib/scrollbar-visibility'
document.body.classList.add('pi-console-theme')
installScrollbarVisibility()
ReactDOM.createRoot(document.getElementById('root')!).render(<App/> )
