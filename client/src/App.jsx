import { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import './App.css'
import LoginButton from './components/auth/LoginButton'
import AuthCallback from './components/auth/AuthCallback'

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
          <div className="App">
            <h1>GitWhistle</h1>
            {user ? (
              <div>
                <p>Welcome! You are logged in.</p>
                <button onClick={logout} className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600">
                  Logout
                </button>
              </div>
            ) : (
              <LoginButton />
            )}
          </div>
        } />
      </Routes>
    </Router>
  )
}

export default App
