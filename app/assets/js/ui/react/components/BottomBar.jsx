import React, { useState, useEffect, useRef } from 'react';
import { Settings, Image, Globe, Folder, ChevronDown } from 'lucide-react';
import { useAppContext } from '../AppContext';

const t = (key, fallback) => (window.Lang && window.Lang.queryJS(key)) || fallback;

const BottomBar = () => {
  useAppContext();
  const [selectedVersion, setSelectedVersion] = useState('');
  const [servers, setServers] = useState([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playText, setPlayText] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isLinksDropdownOpen, setIsLinksDropdownOpen] = useState(false);
  const [showAllServers, setShowAllServers] = useState(false);

  const [statusText, setStatusText] = useState('');
  const [isCooldown, setIsCooldown] = useState(false);
  const [launchStatus, setLaunchStatus] = useState(null);
  const [launchPercent, setLaunchPercent] = useState(null);

  const dropdownRef = useRef(null);
  const linksDropdownRef = useRef(null);

  useEffect(() => {
    const handleServerChanged = (e) => {
      const newServerId = e.detail;
      if (newServerId) {
        setSelectedVersion(newServerId);
      }
    };
    window.addEventListener('server-changed', handleServerChanged);
    return () => {
      window.removeEventListener('server-changed', handleServerChanged);
    };
  }, []);

  useEffect(() => {
    window.onReactLaunchDetails = (details) => setLaunchStatus(details);
    window.onReactLaunchPercentage = (percent) => setLaunchPercent(percent);
    window.onReactLaunchComplete = () => {
      setLaunchStatus(null);
      setLaunchPercent(null);
      setIsCooldown(false);
    };

    // Attempt to load distributions from Helios ConfigManager/DistroAPI
    if (window.DistroAPI) {
      window.DistroAPI.getDistribution().then((distro) => {
        if (distro && distro.servers) {
          let servs = [...distro.servers];
          const now = new Date();
          const month = now.getMonth(); // 0 = Jan, 11 = Dec
          const date = now.getDate();

          const isAroundTheWorld = month >= 4 && month <= 7;
          const isNewYear = month === 11 || (month === 0 && date <= 30);

          servs.sort((a, b) => {
            const aName = (a.rawServer.name || '').toLowerCase();
            const bName = (b.rawServer.name || '').toLowerCase();
            if (isAroundTheWorld) {
              const aMatch = aName.includes('вокруг света');
              const bMatch = bName.includes('вокруг света');
              if (aMatch && !bMatch) return -1;
              if (!aMatch && bMatch) return 1;
            }
            if (isNewYear) {
              const aMatch = aName.includes('новогодний квест') || aName.includes('новогодний');
              const bMatch = bName.includes('новогодний квест') || bName.includes('новогодний');
              if (aMatch && !bMatch) return -1;
              if (!aMatch && bMatch) return 1;
            }
            return 0; // maintain original order
          });

          setServers(servs);
          const currentServ = window.ConfigManager?.getSelectedServer();
          if (currentServ) {
            setSelectedVersion(currentServ);
            window.CURRENT_SELECTED_SERVER_ID = currentServ;
          } else if (servs.length > 0) {
            const defaultServId = servs[0].rawServer.id;
            setSelectedVersion(defaultServId);
            window.CURRENT_SELECTED_SERVER_ID = defaultServId;
            if (window.ConfigManager) {
              window.ConfigManager.setSelectedServer(defaultServId);
              window.ConfigManager.save().catch(err => console.error('[BottomBar] ConfigManager save failed:', err));
            }
          }
        }
      }).catch(err => console.error("Failed to load distros", err));
    }

    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
      if (linksDropdownRef.current && !linksDropdownRef.current.contains(event.target)) {
        setIsLinksDropdownOpen(false);
      }
    };

    // Sync with vanilla launch button
    const launchBtn = document.getElementById('launch_button');
    if (launchBtn) {
      setPlayText(launchBtn.innerText || t('landing.launchButton', 'ИГРАТЬ'));
      setIsPlaying(launchBtn.disabled);

      const observer = new MutationObserver(() => {
        const currentBtn = document.getElementById('launch_button');
        if (currentBtn) {
          setPlayText(currentBtn.innerText || t('landing.launchButton', 'ИГРАТЬ'));
          setIsPlaying(currentBtn.disabled);
        }
      });
      observer.observe(launchBtn, { attributes: true, childList: true, subtree: true, characterData: true });

      // Cleanup
      const cleanupObserver = () => observer.disconnect();
      document.addEventListener("mousedown", handleClickOutside);

      // Track launch details
      const detailsText = document.getElementById('launch_details_text');
      const progressBar = document.getElementById('launch_progress');
      let detailsObserver, progressObserver;

      if (detailsText) {
        detailsObserver = new MutationObserver(() => {
          const currentDetails = document.getElementById('launch_details_text');
          if (currentDetails) setStatusText(currentDetails.innerText);
        });
        detailsObserver.observe(detailsText, { childList: true, characterData: true, subtree: true });
      }

      if (progressBar) {
        progressObserver = new MutationObserver(() => {
          const currentProgress = document.getElementById('launch_progress')
          if (currentProgress) {
            const val = Number(currentProgress.value);
            setLaunchPercent(isNaN(val) ? null : val);
          }
        })
        progressObserver.observe(progressBar, { attributes: true })
      }

      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        cleanupObserver();
        if (detailsObserver) detailsObserver.disconnect();
        if (progressObserver) progressObserver.disconnect();
      };
    } else {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, []);

  const handleLaunch = async () => {
    if (isPlaying || isCooldown || launchStatus) return;

    // Cooldown protection: block rapid re-clicks, always resets after 3s
    // (safety net if launch fails before onReactLaunchComplete fires)
    setIsCooldown(true)
    setTimeout(() => setIsCooldown(false), 3000)

    // FORCE SET AND SAVE BEFORE LAUNCHING
    if (window.ConfigManager && selectedVersion) {
      console.log(`[BottomBar] Forcing ConfigManager.selectedServer to: ${selectedVersion}`);
      window.ConfigManager.setSelectedServer(selectedVersion);
      await window.ConfigManager.save().catch(err => console.error('[BottomBar] ConfigManager save failed:', err));
    }

    const launchBtn = document.getElementById('launch_button');
    if (launchBtn && !launchBtn.disabled) {
      launchBtn.click();
    } else {
      console.error("Vanilla launch button not found or disabled! Logic missing.");
    }
  };

  const handleSettingsClick = async () => {
    if (typeof window.prepareSettings === 'function') {
      await window.prepareSettings();
    }
    if (window.switchView && window.VIEWS) {
      window.switchView(window.getCurrentView(), window.VIEWS.settings);
    }
  };

  const handleVersionChange = (newVal) => {
    setSelectedVersion(newVal);
    setIsDropdownOpen(false);
    window.CURRENT_SELECTED_SERVER_ID = newVal;

    if (window.ConfigManager) {
      window.ConfigManager.setSelectedServer(newVal);
      window.ConfigManager.save().catch(err => console.error('[BottomBar] ConfigManager save failed:', err));
    }

    if (window.updateSelectedServer) {
      if (window.DistroAPI) {
        window.DistroAPI.getDistribution().then(distro => {
          if (distro) {
            window.updateSelectedServer(distro.getServerById(newVal));
          }
        });
      }
    }
  };

  const selectedServerObj = servers.find(s => s.rawServer.id === selectedVersion);
  const displayTitle = selectedServerObj
    ? `${selectedServerObj.rawServer.name} (${selectedServerObj.rawServer.minecraftVersion})`
    : 'Default (1.20.1)';

  return (
    <div className="bottom-bar-wrapper react-glass" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 30px', position: 'relative', zIndex: 50 }}>

      {/* Left side: Custom Version Selector */}
      <div className="bottom-bar-left" style={{ position: 'relative' }} ref={dropdownRef}>
        <div
          className="version-dropdown-header"
          onClick={() => { setIsDropdownOpen(!isDropdownOpen); setShowAllServers(false); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: 'rgba(0,0,0,0.3)',
            padding: '12px 20px',
            borderRadius: 'var(--react-radius-md)',
            cursor: 'pointer',
            border: '1px solid rgba(255,255,255,0.1)',
            width: '280px',
            transition: 'background 0.2s'
          }}
        >
          <div style={{ flex: 1, fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayTitle}</div>
          <ChevronDown size={18} style={{ transform: isDropdownOpen ? 'rotate(180deg)' : 'rotate(0)', transition: '0.2s', flexShrink: 0 }} />
        </div>

        {isDropdownOpen && (
          <div
            className="version-dropdown-container"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 15px)',
              left: 0,
              width: '380px',
              maxHeight: 'calc(100vh - 140px)',
              overflowY: 'auto',
              background: '#141414',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '16px',
              padding: '16px',
              boxShadow: '0 -10px 40px rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 100
            }}
          >
            {servers.length > 0 ? (
              <>
                {(showAllServers ? servers : servers.slice(0, 3)).map((serv) => (
                  <div
                    key={serv.rawServer.id}
                    className="server-item-container"
                    onClick={() => handleVersionChange(serv.rawServer.id)}
                    style={{
                      padding: '12px',
                      cursor: 'pointer',
                      background: selectedVersion === serv.rawServer.id ? 'var(--react-accent-transparent, rgba(255, 165, 0, 0.15))' : 'transparent',
                      border: selectedVersion === serv.rawServer.id ? '1px solid var(--react-accent)' : '1px solid transparent',
                      boxShadow: selectedVersion === serv.rawServer.id ? '0 0 15px var(--react-accent-transparent, rgba(255, 165, 0, 0.2))' : 'none',
                      borderRadius: '12px',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      marginBottom: '8px'
                    }}
                    onMouseOver={(e) => {
                      if (selectedVersion !== serv.rawServer.id) {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                      }
                    }}
                    onMouseOut={(e) => {
                      if (selectedVersion !== serv.rawServer.id) {
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    {/* Image Placeholder */}
                    <div style={{ width: '48px', height: '48px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                      {serv.rawServer.icon ? (
                        <img src={serv.rawServer.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.target.style.display = 'none'; }} />
                      ) : (
                        <Image size={24} style={{ opacity: 0.5 }} />
                      )}
                    </div>

                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', overflow: 'hidden' }}>
                      <div className="server-item-title">
                        {serv.rawServer.name}
                      </div>
                      <div className="server-item-desc">
                        {serv.rawServer.description || 'Описание отсутствует'}
                      </div>
                    </div>

                    <div style={{
                      background: 'var(--react-accent)',
                      color: 'black',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      fontSize: '0.8em',
                      fontWeight: 'bold',
                      flexShrink: 0
                    }}>
                      {serv.rawServer.minecraftVersion}
                    </div>
                  </div>
                ))}
                {!showAllServers && servers.length > 3 && (
                  <div
                    onClick={() => setShowAllServers(true)}
                    style={{
                      padding: '10px',
                      cursor: 'pointer',
                      background: 'rgba(255,255,255,0.05)',
                      borderRadius: '12px',
                      textAlign: 'center',
                      fontWeight: 'bold',
                      color: '#bbb',
                      transition: 'all 0.2s',
                      marginTop: '4px'
                    }}
                    onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'white'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#bbb'; }}
                  >
                    Показать ещё...
                  </div>
                )}
              </>
            ) : (
              <div style={{ padding: '12px 20px' }}>Default (1.20.1)</div>
            )}
          </div>
        )}
      </div>

      {/* Center: Play Button */}
      <div className="bottom-bar-center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
        <button
          className={`play-button ${launchStatus ? 'loading' : ''}`}
          onClick={handleLaunch}
          disabled={isCooldown || launchStatus != null}
          style={{
            width: '260px',
            height: '56px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 16px',
            fontSize: launchStatus ? '13px' : '18px',
            fontWeight: '800',
            position: 'relative',
            overflow: 'hidden',
            transition: 'font-size 0.3s, background-color 0.3s',
            backgroundColor: launchStatus ? 'rgba(0, 0, 0, 0.5)' : undefined,
            boxShadow: launchStatus ? 'none' : undefined
          }}
        >
          {launchStatus && launchPercent !== null && (
            <div
              className="launch-progress-bar"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                height: '100%',
                width: `${launchPercent}%`,
                transition: 'width 0.1s',
                zIndex: 0
              }}
            />
          )}
          <span style={{ position: 'relative', zIndex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
            {launchStatus ? launchStatus : (playText || t('landing.launchButton', 'ИГРАТЬ'))}
          </span>
        </button>
        {isPlaying && statusText && !launchStatus && (
          <div className="fade-in" style={{ fontSize: '0.85em', color: 'rgba(255,255,255,0.7)', textAlign: 'center', maxWidth: '280px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', position: 'absolute', bottom: '-20px' }}>
            {statusText}
          </div>
        )}
      </div>

      {/* Right side: Action Icons */}
      <div className="bottom-bar-right" style={{ display: 'flex', gap: '15px' }}>
        <button className="icon-button" data-tooltip="Скриншоты" onClick={async () => {
          try {
            const path = require('path');
            const fs = require('fs');
            const { ipcRenderer } = require('electron');
            const instanceDir = await window.ConfigManager.getInstanceDirectory();
            if (selectedVersion) {
              const targetPath = path.join(instanceDir, selectedVersion, 'screenshots');
              if (fs.existsSync(targetPath)) {
                await ipcRenderer.invoke('shell:openPath', targetPath);
              }
            }
          } catch (err) {
            console.error('Failed to open screenshots:', err);
          }
        }}>
          <Image size={22} />
        </button>
        <div style={{ position: 'relative' }} ref={linksDropdownRef}>
          <button className="icon-button" data-tooltip={isLinksDropdownOpen ? "" : "Ссылки"} onClick={() => setIsLinksDropdownOpen(!isLinksDropdownOpen)}>
            <Globe size={22} />
          </button>
          {isLinksDropdownOpen && (
            <div
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 15px)',
                right: 0,
                width: '180px',
                background: '#141414',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '16px',
                padding: '8px',
                boxShadow: '0 -10px 40px rgba(0,0,0,0.5)',
                display: 'flex',
                flexDirection: 'column',
                zIndex: 100
              }}
            >
              {[
                { name: 'Сайт Фоксфорд', url: 'https://foxford.ru/programming' },
                { name: 'Руководство по курсу', url: 'https://wiki.f-launcher.ru/' },
                { name: 'Сайт лаунчера', url: 'https://f-launcher.ru/' },
                { name: 'Поддержка Telegram', url: (window.ConfigManager?.getSupportUrl && window.ConfigManager.getSupportUrl()) || 'https://t.me/+1THtTcDneY9iYTVi' },
                { name: 'Поддержка VK', url: (window.ConfigManager?.getSupportVkUrl && window.ConfigManager.getSupportVkUrl()) || 'https://vk.me/join/lmxre6cIUGQBeVCW3_MsPd5BjQ9y/BgoAqk=' }
              ].map(link => (
                <div
                  key={link.name}
                  onClick={() => {
                    try {
                      const { shell } = require('electron');
                      shell.openExternal(link.url);
                    } catch (err) {
                      console.error('Failed to open link:', err);
                    }
                    setIsLinksDropdownOpen(false);
                  }}
                  style={{
                    padding: '10px 12px',
                    cursor: 'pointer',
                    borderRadius: '8px',
                    transition: 'all 0.2s',
                    color: 'white',
                    fontWeight: 'bold',
                    fontSize: '14px',
                    textAlign: 'center'
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {link.name}
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="icon-button" data-tooltip="Папка игры" onClick={async () => {
          try {
            const path = require('path');
            const fs = require('fs');
            const { ipcRenderer } = require('electron');
            const instanceDir = await window.ConfigManager.getInstanceDirectory();
            if (selectedVersion) {
              const targetPath = path.join(instanceDir, selectedVersion);
              if (fs.existsSync(targetPath)) {
                await ipcRenderer.invoke('shell:openPath', targetPath);
              }
            }
          } catch (err) {
            console.error('Failed to open game folder:', err);
          }
        }}>
          <Folder size={22} />
        </button>
        <button className="icon-button" data-tooltip="Настройки" onClick={handleSettingsClick}>
          <Settings size={22} />
        </button>
      </div>
    </div>
  );
};

export default BottomBar;
