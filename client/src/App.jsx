import { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import LoginButton from './components/auth/LoginButton'
import AuthCallback from './components/auth/AuthCallback'
import GitHubApp from './components/GitHubApp'


function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Check for token in URL first
    const urlParams = new URLSearchParams(window.location.search)
    const urlToken = urlParams.get('token')
    
    if (urlToken) {
      localStorage.setItem('token', urlToken)
      setUser({ token: urlToken })
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname)
    } else {
      const token = localStorage.getItem('token')
      if (token) {
        setUser({ token })
      }
    }
    setLoading(false)
  }, [])

  const logout = () => {
    localStorage.removeItem('token')
    setUser(null)
  }

  if (loading) return <div>Loading...</div>

  return (
    <Router>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/" element={
          <div className="min-h-screen ">
            {user ? (
              <div>
                <nav className="bg-white shadow-sm border-b border-gray-200">
                  <div className="max-w-6xl mx-auto px-4 py-4">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center space-x-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg flex items-center justify-center">
                          <span className="text-white font-bold text-sm">GW</span>
                        </div>
                        <span className="text-xl font-bold text-gray-900">GitWhistle</span>
                      </div>
                      <button 
                        onClick={logout} 
                        className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                      >
                        Logout
                      </button>
                    </div>
                  </div>
                </nav>
                <GitHubApp />
              </div>
            ) : (
              <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-20 h-20 bg-gradient-to-br from-blue-600 to-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-8">
                    <span className="text-white font-bold text-2xl">GW</span>
                  </div>
                  <h1 className="text-4xl font-bold text-gray-900 mb-4">GitWhistle</h1>
                  <p className="text-xl text-gray-600 mb-8">Real-time GitHub notifications made simple</p>
                  <LoginButton />
                </div>
              </div>
            )}
          </div>
        } />
      </Routes>
    </Router>
  )
}

export default App
