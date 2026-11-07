import '@vis/ui-kit/theme.css'
import './app.css'
import { createRoot } from 'react-dom/client'
import { LocaleApp } from './LocaleApp'

// The token follows # in the URL so it is not sent to the server; store it in this tab and remove it from the address bar after reading
const fromHash = new URLSearchParams(location.hash.slice(1)).get('t')
if (fromHash) {
  sessionStorage.setItem('vis-token', fromHash)
  history.replaceState(null, '', location.pathname + location.search)
}
const token = sessionStorage.getItem('vis-token')
const root = createRoot(document.getElementById('root')!)
root.render(<LocaleApp token={token} />)
