import { useState, useEffect } from 'react';

const GitHubApp = () => {
  const [installations, setInstallations] = useState([]);
  const [repositories, setRepositories] = useState({});
  const [loading, setLoading] = useState(true);
  const [showAddRepos, setShowAddRepos] = useState(false);
  const [availableRepos, setAvailableRepos] = useState([]);
  const [selectedInstallation, setSelectedInstallation] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [availableRepos, setAvailableRepos] = useState([]);
  const [availableTypes, setAvailableTypes] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState('all');
  const [selectedType, setSelectedType] = useState('all');

  useEffect(() => {
    fetchInstallations();
    fetchNotifications();
    fetchFilterOptions();
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [selectedRepo, selectedType]);

  const fetchInstallations = async () => {
    try {
      const response = await fetch('http://localhost:4000/api/installations');
      const data = await response.json();
      setInstallations(data);
      
      for (const installation of data) {
        fetchRepositories(installation.installation_id);
      }
    } catch (error) {
      console.error('Error fetching installations:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchRepositories = async (installationId) => {
    try {
      const response = await fetch(`http://localhost:4000/api/installations/${installationId}/repositories`);
      const repos = await response.json();
      setRepositories(prev => ({ ...prev, [installationId]: repos }));
    } catch (error) {
      console.error('Error fetching repositories:', error);
    }
  };

  const toggleRepository = async (installationId, repoId, enabled) => {
    try {
      if (enabled) {
        await fetch(`http://localhost:4000/api/installations/${installationId}/repositories/${repoId}`, {
          method: 'DELETE'
        });
      } else {
        await fetch(`http://localhost:4000/api/installations/${installationId}/repositories/${repoId}`, {
          method: 'POST'
        });
      }
      fetchRepositories(installationId);
    } catch (error) {
      console.error('Error toggling repository:', error);
    }
  };

  const syncRepositories = async (installationId) => {
    try {
      await fetch(`http://localhost:4000/api/installations/${installationId}/sync`, {
        method: 'POST'
      });
      fetchRepositories(installationId);
    } catch (error) {
      console.error('Error syncing repositories:', error);
    }
  };

  const handleAddRepos = () => {
    if (installations.length === 0) {
      window.open('https://github.com/apps/gitwhistle-app/installations/new', '_blank');
    } else {
      setShowAddRepos(true);
      if (installations.length === 1) {
        setSelectedInstallation(installations[0]);
        fetchAvailableRepos(installations[0].installation_id);
      }
    }
  };

  const fetchAvailableRepos = async (installationId) => {
    try {
      await fetch(`http://localhost:4000/api/installations/${installationId}/sync`, {
        method: 'POST'
      });
      await fetchRepositories(installationId);
      const repos = repositories[installationId] || [];
      setAvailableRepos(repos);
    } catch (error) {
      console.error('Error fetching available repos:', error);
    }
  };

  const selectInstallation = (installation) => {
    setSelectedInstallation(installation);
    fetchAvailableRepos(installation.installation_id);
  };

  const fetchNotifications = async () => {
    try {
      const params = new URLSearchParams();
      if (selectedRepo !== 'all') params.append('repo', selectedRepo);
      if (selectedType !== 'all') params.append('type', selectedType);
      params.append('limit', '50');
      
      const response = await fetch(`http://localhost:4000/api/notifications?${params}`);
      const data = await response.json();
      setNotifications(data);
    } catch (error) {
      console.error('Error fetching notifications:', error);
    }
  };

  const fetchFilterOptions = async () => {
    try {
      const [reposRes, typesRes] = await Promise.all([
        fetch('http://localhost:4000/api/notifications/repositories'),
        fetch('http://localhost:4000/api/notifications/types')
      ]);
      const repos = await reposRes.json();
      const types = await typesRes.json();
      setAvailableRepos(repos);
      setAvailableTypes(types);
    } catch (error) {
      console.error('Error fetching filter options:', error);
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-black flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-purple-900/20 to-cyan-900/20"></div>
      <div className="text-center relative z-10">
        <div className="relative mb-8">
          <div className="w-20 h-20 border-4 border-cyan-400 rounded-lg animate-pulse mx-auto mb-4 shadow-lg shadow-cyan-400/50"></div>
          <div className="text-6xl font-mono font-black text-cyan-400 animate-bounce mb-2 drop-shadow-lg" style={{textShadow: '0 0 20px #00ffff'}}>LOADING</div>
        </div>
        <h3 className="text-4xl font-mono font-black text-yellow-400 mb-4 animate-pulse" style={{textShadow: '0 0 20px #ffff00'}}>GITWHISTLE</h3>
        <p className="text-xl font-mono text-green-400" style={{textShadow: '0 0 10px #00ff00'}}>INITIALIZING SYSTEM...</p>
      </div>
    </div>
  );

  const totalRepos = Object.values(repositories).flat().filter(repo => repo.enabled).length;
  const totalEvents = notifications.length;

  return (
    <div className="min-h-screen bg-black relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-purple-900/30 via-blue-900/30 to-green-900/30"></div>
      <div className="flex relative z-10">
        {/* Sidebar */}
        <div className="w-80 bg-black border-r-4 border-cyan-400 min-h-screen relative overflow-hidden shadow-2xl shadow-cyan-400/20">
          <div className="absolute inset-0 bg-gradient-to-b from-cyan-900/20 to-purple-900/20"></div>
          <div className="relative z-10">
            <div className="p-4 border-b-2 border-yellow-400">
              <div className="text-center">
                <div className="w-10 h-10 bg-black border-2 border-cyan-400 flex items-center justify-center mx-auto mb-2 shadow-lg shadow-cyan-400/50">
                  <span className="text-lg animate-pulse">🚀</span>
                </div>
                <h1 className="text-xl font-mono font-black text-cyan-400 mb-1 animate-pulse" style={{textShadow: '0 0 15px #00ffff'}}>GITWHISTLE</h1>
                <p className="text-xs font-mono text-yellow-400" style={{textShadow: '0 0 8px #ffff00'}}>ARCADE EDITION</p>
              </div>
            </div>
          
            <nav className="p-4 space-y-2">
              <button
                onClick={() => setActiveTab('dashboard')}
                className={`w-full flex items-center space-x-3 px-4 py-3 border-2 text-left transition-all duration-300 font-mono font-bold text-sm ${
                  activeTab === 'dashboard' 
                    ? 'border-cyan-400 bg-cyan-400/20 text-cyan-400 shadow-lg shadow-cyan-400/50' 
                    : 'border-gray-600 text-gray-400 hover:border-cyan-400 hover:text-cyan-400 hover:shadow-lg hover:shadow-cyan-400/30'
                }`}
                style={activeTab === 'dashboard' ? {textShadow: '0 0 8px #00ffff'} : {}}
              >
                <span className="text-lg">📊</span>
                <span>[1] DASHBOARD</span>
                {activeTab === 'dashboard' && <div className="ml-auto w-2 h-2 bg-cyan-400 animate-ping"></div>}
              </button>
              <button
                onClick={() => setActiveTab('repositories')}
                className={`w-full flex items-center space-x-3 px-4 py-3 border-2 text-left transition-all duration-300 font-mono font-bold text-sm ${
                  activeTab === 'repositories' 
                    ? 'border-green-400 bg-green-400/20 text-green-400 shadow-lg shadow-green-400/50' 
                    : 'border-gray-600 text-gray-400 hover:border-green-400 hover:text-green-400 hover:shadow-lg hover:shadow-green-400/30'
                }`}
                style={activeTab === 'repositories' ? {textShadow: '0 0 8px #00ff00'} : {}}
              >
                <span className="text-lg">📁</span>
                <span>[2] REPOS</span>
                {activeTab === 'repositories' && <div className="ml-auto w-2 h-2 bg-green-400 animate-ping"></div>}
              </button>
            </nav>
          
            <div className="absolute bottom-4 left-4 right-4">
              <button 
                onClick={handleAddRepos}
                className="w-full bg-black border-2 border-magenta-500 text-magenta-400 px-4 py-3 font-mono font-black text-sm transition-all duration-300 flex items-center justify-center space-x-2 shadow-xl shadow-magenta-500/50 hover:bg-magenta-500/20 hover:shadow-magenta-500/70 animate-pulse"
                style={{textShadow: '0 0 10px #ff00ff'}}
              >
                <span className="text-lg animate-bounce">💰</span>
                <span>INSERT COIN</span>
              </button>
            </div>
          </div>
        </div>
        
        {/* Main Content */}
        <div className="flex-1 p-8 overflow-y-auto bg-black relative">
          <div className="absolute inset-0 bg-gradient-to-br from-purple-900/10 via-blue-900/10 to-green-900/10"></div>
          {activeTab === 'dashboard' && (
            <div className="space-y-8 relative z-10">
              <div className="text-center mb-8 border-2 border-cyan-400 bg-black/80 p-4">
                <h2 className="text-2xl font-mono font-black text-cyan-400 mb-2 animate-pulse flex items-center justify-center space-x-2" style={{textShadow: '0 0 15px #00ffff'}}>
                  <span>🖥️</span>
                  <span>SYSTEM STATUS</span>
                  <span>🖥️</span>
                </h2>
                <p className="text-sm font-mono text-yellow-400" style={{textShadow: '0 0 8px #ffff00'}}>MONITORING GITHUB ACTIVITY...</p>
              </div>
              
              {/* Stats Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <div className="relative">
                  <div className="bg-black border-2 border-cyan-400 p-4 shadow-xl shadow-cyan-400/50 hover:shadow-cyan-400/70 transition-all duration-300">
                    <div className="text-center">
                      <div className="flex items-center justify-center space-x-2 mb-2">
                        <span className="text-lg">📁</span>
                        <div className="text-3xl font-mono font-black text-cyan-400 animate-pulse" style={{textShadow: '0 0 15px #00ffff'}}>{totalRepos}</div>
                      </div>
                      <p className="text-sm font-mono font-bold text-white mb-2">ACTIVE REPOS</p>
                      <div className="w-full h-1 bg-gray-800 border border-cyan-400">
                        <div className="h-full bg-cyan-400 animate-pulse" style={{width: `${Math.min(totalRepos * 10, 100)}%`}}></div>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="relative">
                  <div className="bg-black border-2 border-green-400 p-4 shadow-xl shadow-green-400/50 hover:shadow-green-400/70 transition-all duration-300">
                    <div className="text-center">
                      <div className="flex items-center justify-center space-x-2 mb-2">
                        <span className="text-lg">⚡</span>
                        <div className="text-3xl font-mono font-black text-green-400 animate-pulse" style={{textShadow: '0 0 15px #00ff00'}}>{totalEvents}</div>
                      </div>
                      <p className="text-sm font-mono font-bold text-white mb-2">EVENTS</p>
                      <div className="w-full h-1 bg-gray-800 border border-green-400">
                        <div className="h-full bg-green-400 animate-pulse" style={{width: `${Math.min(totalEvents * 5, 100)}%`}}></div>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="relative">
                  <div className="bg-black border-2 border-yellow-400 p-4 shadow-xl shadow-yellow-400/50 hover:shadow-yellow-400/70 transition-all duration-300">
                    <div className="text-center">
                      <div className="flex items-center justify-center space-x-2 mb-2">
                        <span className="text-lg">🔗</span>
                        <div className="text-3xl font-mono font-black text-yellow-400 animate-pulse" style={{textShadow: '0 0 15px #ffff00'}}>{installations.length}</div>
                      </div>
                      <p className="text-sm font-mono font-bold text-white mb-2">CONNECTIONS</p>
                      <div className="w-full h-1 bg-gray-800 border border-yellow-400">
                        <div className="h-full bg-yellow-400 animate-pulse" style={{width: `${Math.min(installations.length * 25, 100)}%`}}></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Filtered Events */}
              <div className="relative">
                <div className="bg-black border-2 border-purple-400 shadow-xl shadow-purple-400/50">
                  <div className="p-4 border-b-2 border-purple-400">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center space-x-2">
                        <span className="text-lg">🔍</span>
                        <h3 className="text-lg font-mono font-black text-purple-400" style={{textShadow: '0 0 10px #a855f7'}}>EVENT MONITOR</h3>
                      </div>
                      <button 
                        onClick={fetchNotifications}
                        className="bg-black border-2 border-cyan-400 text-cyan-400 px-3 py-2 font-mono font-bold text-xs transition-all duration-300 shadow-lg shadow-cyan-400/50 hover:bg-cyan-400/20 flex items-center space-x-1"
                        style={{textShadow: '0 0 8px #00ffff'}}
                      >
                        <span>🔄</span>
                        <span>REFRESH</span>
                      </button>
                    </div>
                    
                    {/* Filters */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-mono text-yellow-400 mb-1" style={{textShadow: '0 0 5px #ffff00'}}>REPOSITORY:</label>
                        <select 
                          value={selectedRepo}
                          onChange={(e) => setSelectedRepo(e.target.value)}
                          className="w-full bg-black border-2 border-yellow-400 text-yellow-400 px-3 py-2 font-mono text-sm focus:outline-none focus:shadow-lg focus:shadow-yellow-400/50"
                          style={{textShadow: '0 0 5px #ffff00'}}
                        >
                          <option value="all">[ALL REPOS]</option>
                          {availableRepos.map(repo => (
                            <option key={repo} value={repo}>{repo}</option>
                          ))}
                        </select>
                      </div>
                      
                      <div>
                        <label className="block text-xs font-mono text-green-400 mb-1" style={{textShadow: '0 0 5px #00ff00'}}>EVENT TYPE:</label>
                        <select 
                          value={selectedType}
                          onChange={(e) => setSelectedType(e.target.value)}
                          className="w-full bg-black border-2 border-green-400 text-green-400 px-3 py-2 font-mono text-sm focus:outline-none focus:shadow-lg focus:shadow-green-400/50"
                          style={{textShadow: '0 0 5px #00ff00'}}
                        >
                          <option value="all">[ALL TYPES]</option>
                          {availableTypes.map(type => (
                            <option key={type} value={type}>{type.toUpperCase()}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                  <div className="p-4 max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <div className="text-center py-8">
                        <div className="w-16 h-16 bg-black border-2 border-red-400 flex items-center justify-center mx-auto mb-4">
                          <span className="text-2xl animate-pulse">📡</span>
                        </div>
                        <h4 className="text-lg font-mono font-bold text-red-400 mb-2" style={{textShadow: '0 0 10px #ef4444'}}>NO DATA FOUND</h4>
                        <p className="text-sm font-mono text-gray-400">Adjust filters or add repositories</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {notifications.map((notification, index) => {
                          const payload = typeof notification.payload === 'string' ? JSON.parse(notification.payload) : notification.payload;
                          const getEventColor = (type) => {
                            switch(type) {
                              case 'push': return 'border-purple-400 text-purple-400';
                              case 'issues': return 'border-blue-400 text-blue-400';
                              case 'pull_request': return 'border-green-400 text-green-400';
                              default: return 'border-gray-400 text-gray-400';
                            }
                          };
                          const getEventIcon = (type) => {
                            switch(type) {
                              case 'push': return '📤';
                              case 'issues': return '🐛';
                              case 'pull_request': return '🔀';
                              default: return '📋';
                            }
                          };
                          return (
                            <div key={index} className={`bg-black border-2 ${getEventColor(notification.type)} p-3 hover:shadow-lg transition-all duration-300`}>
                              <div className="flex items-center space-x-3">
                                <span className="text-lg">{getEventIcon(notification.type)}</span>
                                <div className="flex-1">
                                  <div className="flex items-center space-x-2 mb-1">
                                    <span className={`font-mono font-bold text-xs px-2 py-1 border ${getEventColor(notification.type)}`}>
                                      {notification.type.toUpperCase()}
                                    </span>
                                    <span className={`font-mono text-sm ${getEventColor(notification.type).split(' ')[1]}`}>
                                      {payload.action} {notification.type === 'pull_request' ? `#${payload.pr_number}` : 
                                       notification.type === 'issues' ? `#${payload.issue_number}` :
                                       notification.type === 'push' ? `${payload.commits_count}` : ''}
                                    </span>
                                  </div>
                                  <p className="text-xs font-mono text-white truncate">{payload.title || 'No title'}</p>
                                  <div className="flex items-center justify-between mt-1">
                                    <span className="text-xs font-mono text-yellow-400">📁 {notification.repo_name}</span>
                                    <span className="text-xs font-mono text-gray-500">
                                      {new Date(notification.created_at).toLocaleTimeString()}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'repositories' && (
            <div>
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">Repository Management</h2>
                <p className="text-gray-600">Manage your connected GitHub repositories</p>
              </div>
              
              {installations.length === 0 ? (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-12 text-center">
                  <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                    <span className="text-3xl text-white">🚀</span>
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">Connect Your First Repository</h3>
                  <p className="text-gray-600 mb-6">Install the GitWhistle GitHub App to start monitoring your repositories</p>
                  <button 
                    onClick={handleAddRepos}
                    className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white px-6 py-3 rounded-lg font-medium"
                  >
                    Install GitHub App
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  {installations.map(installation => {
                    const meta = typeof installation.meta === 'string' ? JSON.parse(installation.meta) : installation.meta;
                    const installationRepos = repositories[installation.installation_id] || [];
                    const enabledRepos = installationRepos.filter(repo => repo.enabled);
                    
                    return (
                      <div key={installation.installation_id} className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                        <div className="bg-gradient-to-r from-gray-50 to-blue-50 px-6 py-4 border-b border-gray-200">
                          <div className="flex justify-between items-center">
                            <div className="flex items-center space-x-4">
                              <div className="w-12 h-12 bg-gradient-to-br from-green-500 to-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-lg">
                                {meta.account?.login?.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <h3 className="text-lg font-semibold text-gray-900">{meta.account?.login}</h3>
                                <p className="text-sm text-gray-500">{enabledRepos.length} active repositories</p>
                              </div>
                            </div>
                            <button 
                              onClick={() => syncRepositories(installation.installation_id)}
                              className="bg-white hover:bg-gray-50 border border-gray-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center space-x-2"
                            >
                              <span>🔄</span>
                              <span>Sync</span>
                            </button>
                          </div>
                        </div>
                        
                        <div className="p-6">
                          {enabledRepos.length === 0 ? (
                            <div className="text-center py-8">
                              <p className="text-gray-500 mb-4">No repositories enabled</p>
                              <button 
                                onClick={handleAddRepos}
                                className="text-blue-600 hover:text-blue-700 font-medium"
                              >
                                Add repositories →
                              </button>
                            </div>
                          ) : (
                            <div className="grid gap-3">
                              {enabledRepos.map(repo => (
                                <div key={repo.repo_id} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors">
                                  <div className="flex items-center space-x-3">
                                    <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                                    <span className="font-mono text-sm font-medium text-gray-900">{repo.full_name}</span>
                                  </div>
                                  <button
                                    onClick={() => toggleRepository(installation.installation_id, repo.repo_id, repo.enabled)}
                                    className="text-red-600 hover:text-red-700 hover:bg-red-50 px-3 py-1 rounded-md text-sm font-medium transition-colors"
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'events' && (
            <div>
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">All Events</h2>
                <p className="text-gray-600">Complete history of your GitHub activity</p>
              </div>
              
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200">
                <div className="p-6 border-b border-gray-200">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                      <h3 className="text-lg font-semibold text-gray-900">Event Timeline</h3>
                      <span className="text-sm text-gray-500">({notifications.length})</span>
                    </div>
                    <button 
                      onClick={fetchNotifications}
                      className="bg-blue-50 hover:bg-blue-100 text-blue-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center space-x-2"
                    >
                      <span>🔄</span>
                      <span>Refresh</span>
                    </button>
                  </div>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="p-12 text-center">
                      <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <span className="text-2xl">📡</span>
                      </div>
                      <p className="text-gray-500 mb-2">No events yet</p>
                      <p className="text-sm text-gray-400">Create an issue or PR in your selected repositories</p>
                    </div>
                  ) : (
                    notifications.map((notification, index) => {
                      const payload = typeof notification.payload === 'string' ? JSON.parse(notification.payload) : notification.payload;
                      const getEventIcon = (type) => {
                        switch(type) {
                          case 'pull_request': return '🔀';
                          case 'issues': return '🐛';
                          case 'push': return '📤';
                          default: return '📋';
                        }
                      };
                      return (
                        <div key={notification.id || index} className="p-4 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors">
                          <div className="flex items-start space-x-4">
                            <div className="flex-shrink-0">
                              <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white text-sm">
                                {getEventIcon(notification.type)}
                              </div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center space-x-2">
                                  <span className={`px-3 py-1 text-xs font-medium rounded-full ${
                                    notification.type === 'pull_request' ? 'bg-green-100 text-green-800' :
                                    notification.type === 'issues' ? 'bg-blue-100 text-blue-800' :
                                    notification.type === 'push' ? 'bg-purple-100 text-purple-800' :
                                    'bg-gray-100 text-gray-800'
                                  }`}>
                                    {notification.type.replace('_', ' ')}
                                  </span>
                                  <span className="text-sm font-semibold text-gray-900">
                                    {payload.action} {notification.type === 'pull_request' ? `PR #${payload.pr_number}` : 
                                     notification.type === 'issues' ? `Issue #${payload.issue_number}` :
                                     notification.type === 'push' ? `${payload.commits_count} commits` : ''}
                                  </span>
                                  {payload.state && (
                                    <span className={`px-2 py-1 text-xs rounded ${
                                      payload.state === 'open' ? 'bg-green-100 text-green-700' :
                                      payload.state === 'closed' ? 'bg-red-100 text-red-700' :
                                      'bg-gray-100 text-gray-700'
                                    }`}>
                                      {payload.state}
                                    </span>
                                  )}
                                </div>
                                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                                  {new Date(notification.created_at).toLocaleTimeString()}
                                </span>
                              </div>
                              
                              {payload.title && (
                                <p className="text-sm text-gray-900 mb-2 font-medium">{payload.title}</p>
                              )}
                              
                              {payload.body && (
                                <p className="text-sm text-gray-600 mb-2 line-clamp-2">{payload.body}</p>
                              )}
                              
                              {payload.commits && payload.commits.length > 0 && (
                                <div className="mb-2">
                                  <p className="text-xs text-gray-500 mb-1">Recent commits:</p>
                                  {payload.commits.map((commit, i) => (
                                    <p key={i} className="text-xs text-gray-600 truncate">• {commit.message}</p>
                                  ))}
                                </div>
                              )}
                              
                              {payload.labels && payload.labels.length > 0 && (
                                <div className="flex flex-wrap gap-1 mb-2">
                                  {payload.labels.map((label, i) => (
                                    <span key={i} className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded">
                                      {label}
                                    </span>
                                  ))}
                                </div>
                              )}
                              
                              <div className="flex items-center justify-between text-xs text-gray-500">
                                <div className="flex items-center space-x-4">
                                  {payload.author && <span>👤 {payload.author}</span>}
                                  {notification.repo_name && <span>📁 {notification.repo_name}</span>}
                                  {payload.additions && payload.deletions && (
                                    <span>📊 +{payload.additions} -{payload.deletions}</span>
                                  )}
                                </div>
                                {payload.url && (
                                  <a 
                                    href={payload.url} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:text-blue-700 font-medium"
                                  >
                                    View →
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal for adding repositories */}
      {showAddRepos && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-semibold text-gray-900">Select Repositories</h3>
                <button 
                  onClick={() => setShowAddRepos(false)}
                  className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full p-2 transition-colors"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="p-6 overflow-y-auto">
              {installations.length > 1 && (
                <div className="mb-6">
                  <label className="block text-sm font-medium text-gray-700 mb-3">Choose Installation:</label>
                  <select 
                    onChange={(e) => selectInstallation(installations.find(i => i.installation_id == e.target.value))}
                    className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select an installation...</option>
                    {installations.map(installation => {
                      const meta = typeof installation.meta === 'string' ? JSON.parse(installation.meta) : installation.meta;
                      return (
                        <option key={installation.installation_id} value={installation.installation_id}>
                          {meta.account?.login}
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}
              
              {selectedInstallation && (
                <div>
                  <h4 className="font-semibold text-gray-900 mb-4 flex items-center">
                    <span className="mr-2">📁</span>
                    Available Repositories
                  </h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {availableRepos.map(repo => (
                      <div key={repo.repo_id} className="p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={repo.enabled}
                            onChange={() => toggleRepository(
                              selectedInstallation.installation_id, 
                              repo.repo_id, 
                              repo.enabled
                            )}
                            className="mr-4 h-5 w-5 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                          />
                          <div>
                            <span className="font-mono text-sm font-medium text-gray-900">{repo.full_name}</span>
                            <p className="text-xs text-gray-500 mt-1">
                              {repo.enabled ? '✓ Receiving notifications' : 'Click to enable notifications'}
                            </p>
                          </div>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GitHubApp;