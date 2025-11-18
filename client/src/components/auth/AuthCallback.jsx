import { useEffect } from 'react';

export default function AuthCallback() {
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const error = urlParams.get('error');
    
    if (token) {
      localStorage.setItem('token', token);
      window.location.href = '/';
    } else if (error) {
      console.error('Auth error:', error);
      window.location.href = '/?error=' + error;
    }
  }, []);

  return <div>Authenticating...</div>;
}