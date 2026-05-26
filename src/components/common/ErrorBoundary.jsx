import React from 'react'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-black flex items-center justify-center p-8">
          <div className="max-w-md w-full border border-red-900 p-8 text-center">
            <p className="text-xs font-mono text-red-400 uppercase tracking-widest mb-4">Critical Error</p>
            <p className="text-sm text-white mb-2">{this.state.error?.message || 'Unexpected error'}</p>
            <p className="text-xs text-zinc-600 mb-6">Check the browser console for details.</p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-6 py-2 text-sm border border-zinc-700 text-white hover:bg-zinc-900 transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
