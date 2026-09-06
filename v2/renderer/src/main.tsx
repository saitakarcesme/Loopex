import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/conversation.css'
import './styles/checkpoints.css'
import './styles/panels.css'
import './styles/settings.css'
import './styles/shell.css'
import './styles/tokens.css'
import './styles/desktop.css'
import './styles/lab-pages.css'
import './styles/sidebar-reference.css'
import './styles/composer-reference.css'

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state: { error: string | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    if (this.state.error)
      return (
        <div className="crash-screen">
          <div className="brand-glyph">a</div>
          <h1>Let’s reopen your workspace</h1>
          <p>Your saved tasks are still on this computer.</p>
          <pre>{this.state.error}</pre>
          <button className="primary-button" onClick={() => location.reload()}>
            Reload workspace
          </button>
        </div>
      )
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
