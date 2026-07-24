import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
import './index.css'
import './styles/theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label="root">
    <App />
  </ErrorBoundary>,
)

