import React from 'react'
import ReactDOM from 'react-dom/client'
import KarmaConnectAI from './KarmaConnectAI.jsx'

// Catches any render-time error so the user sees a recovery screen, not a blank page.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('Karma Connect crashed:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh', background: '#040a24', color: '#eef2fb',
          fontFamily: 'Manrope, system-ui, sans-serif', display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center',
        }}>
          <div style={{ maxWidth: 460 }}>
            <h1 style={{ fontFamily: 'Lora, serif', fontSize: 24, marginBottom: 12 }}>Something went wrong</h1>
            <p style={{ color: '#9aa7c4', fontSize: 14, lineHeight: 1.6, marginBottom: 20 }}>
              The app hit an unexpected error. Your saved prospect is still stored locally, so reloading should bring it back.
            </p>
            <pre style={{
              background: 'rgba(255,255,255,.05)', border: '1px solid rgba(74,134,200,.26)',
              borderRadius: 10, padding: 12, fontSize: 12, color: '#ffb3b3', overflow: 'auto',
              textAlign: 'left', marginBottom: 20,
            }}>{String(this.state.error?.message || this.state.error)}</pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: '#FFCF00', color: '#071855', border: 'none', borderRadius: 12,
                padding: '12px 22px', fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}>
              Reload the app
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <KarmaConnectAI />
    </ErrorBoundary>
  </React.StrictMode>
)
