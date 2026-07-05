import React, { useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAppContext } from '../AppContext';

const UserProfile = () => {
  useAppContext();
  const [userData, setUserData] = useState({
    displayName: 'Гость',
    avatarUrl: 'https://mc-heads.net/head/8667ba71b85a4004af54457a9734eed7/100' // MHF_Steve fallback
  });

  const fallback = 'https://mc-heads.net/head/8667ba71b85a4004af54457a9734eed7/100';

  useEffect(() => {
    const updateProfile = (authUser) => {
      if (authUser) {
        const { getCachedAvatar } = require('../../../core/util/AvatarCache')
        const isOffline = authUser.accessToken === 'offline-access-token'
        const identifier = (isOffline || !authUser.uuid) 
            ? (authUser.displayName || authUser.username || authUser.uuid) 
            : authUser.uuid

        const cachedUrl = getCachedAvatar(identifier, 'head', (newUrl) => {
          setUserData(prev => ({ ...prev, avatarUrl: newUrl }))
        })
        setUserData({
          displayName: authUser.displayName,
          avatarUrl: cachedUrl
        });
      } else {
        setUserData({
          displayName: window.Lang ? window.Lang.queryJS('landing.selectedAccount.noAccountSelected') || 'Гость' : 'Гость',
          avatarUrl: fallback
        });
      }
    };

    // Initial load
    if (window.ConfigManager) {
      updateProfile(window.ConfigManager.getSelectedAccount());
    }

    // Listen for updates
    const handleAccountChange = (e) => updateProfile(e.detail);
    window.addEventListener('account-changed', handleAccountChange);
    return () => window.removeEventListener('account-changed', handleAccountChange);
  }, []);

  const handleProfileClick = () => {
    if (window.switchView && window.VIEWS) {
      window.switchView(window.getCurrentView(), window.VIEWS.settings, 500, 500, () => {
        const accTab = document.getElementById('settingsNavAccount');
        if (accTab) accTab.click();
      });
    }
  };

  return (
    <div className="user-profile-wrapper react-glass" onClick={handleProfileClick}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', overflow: 'hidden', flexShrink: 0, border: '2px solid rgba(255,255,255,0.1)' }}>
          <img 
            src={userData.avatarUrl || fallback} 
            alt="Avatar" 
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
            onError={(e) => { e.target.src = fallback; }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontWeight: 'bold', fontSize: '18px' }}>
            {userData.displayName || 'Unknown'}
          </div>
        </div>
      <ChevronDown size={18} className="user-arrow" />
    </div>
  );
};

export default UserProfile;
