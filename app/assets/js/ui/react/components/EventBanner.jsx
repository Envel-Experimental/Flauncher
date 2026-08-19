import React, { useState, useEffect } from 'react';

const LOCAL_EVENT_FALLBACK = {
  show: false,
  title: 'Добро пожаловать!',
  date: 'Следите за новостями проекта',
  imageUrl: 'assets/images/backgrounds/0.jpg', // Path relative to index.html
  link: 'https://f-launcher.ru'
};

const EventBanner = () => {
  const [eventData, setEventData] = useState(LOCAL_EVENT_FALLBACK);
  const [isFading, setIsFading] = useState(false);
  const [isHiddenByUser, setIsHiddenByUser] = useState(false);

  const resolveEventData = (data) => {
    if (!data || typeof data !== 'object') return LOCAL_EVENT_FALLBACK;
    // Preset support: if 'active' and 'presets' exist, resolve the active preset
    if (data.presets && typeof data.presets === 'object') {
      const activeKey = data.active;
      if (activeKey && data.presets[activeKey]) {
        return {
          ...LOCAL_EVENT_FALLBACK,
          ...data.presets[activeKey]
        };
      }
      // If active is explicitly null/false or preset not found, hide banner
      if (activeKey === null || activeKey === false || activeKey === 'none' || activeKey === '') {
        return { ...LOCAL_EVENT_FALLBACK, show: false };
      }
    }
    // Backward compatibility: top-level fields (title, imageUrl, etc.)
    return {
      ...LOCAL_EVENT_FALLBACK,
      ...data
    };
  };

  useEffect(() => {
    // 1. Try to load cached remote event immediately
    const cachedConfig = localStorage.getItem('helios_event_config');
    if (cachedConfig) {
      try {
        const parsed = JSON.parse(cachedConfig);
        setEventData(resolveEventData(parsed));
      } catch (e) {
        console.error('Failed to parse cached event config', e);
      }
    }

    // 2. Fetch fresh config from remote (simulated)
    const fetchRemoteEvent = async () => {
      try {
        const response = await fetch('https://f-launcher.ru/fox/new/launcher-news.json?t=' + Date.now());
        if (!response.ok) throw new Error('News not found or error');
        
        const freshData = await response.json();

        // Cache the raw fresh data
        localStorage.setItem('helios_event_config', JSON.stringify(freshData));

        const resolved = resolveEventData(freshData);

        // If data is different from current, trigger fade transition
        setIsFading(true);

        // Wait for fade out, then swap data and fade back in
        setTimeout(() => {
          setEventData(resolved);
          setIsFading(false);
        }, 500); // 500ms matches the CSS transition

      } catch (err) {
        console.log('No active remote event or failed to fetch:', err);
      }
    };

    fetchRemoteEvent();
  }, []);

  useEffect(() => {
    const isVisible = eventData.show !== false && !isHiddenByUser;
    if (isVisible) {
      document.body.classList.add('news-blur');
    } else {
      document.body.classList.remove('news-blur');
    }
    return () => document.body.classList.remove('news-blur');
  }, [eventData.show, isHiddenByUser]);

  const handleClick = () => {
    if (eventData.link && window.HeliosAPI?.shell) {
      window.HeliosAPI.shell.openExternal(eventData.link);
    } else {
      console.log('Open link:', eventData.link);
    }
  };

  const handleHide = (e) => {
    e.stopPropagation(); // Prevent clicking the banner itself
    setIsHiddenByUser(true);
  };

  if (eventData.show === false || isHiddenByUser) {
    return null;
  }

  return (
    <div className="event-banner-wrapper" onClick={handleClick} style={{ position: 'relative' }}>
      <button 
        onClick={handleHide}
        title="Скрыть новость"
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          background: 'rgba(0,0,0,0.4)',
          border: 'none',
          borderRadius: '5px',
          color: 'white',
          padding: '5px',
          cursor: 'pointer',
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 0.2s'
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.7)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.4)'}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
          <line x1="2" x2="22" y1="2" y2="22"/>
        </svg>
      </button>
      <img
        src={eventData.imageUrl}
        alt={eventData.title}
        className="event-banner-img"
        style={{ opacity: isFading ? 0 : 1 }}
        onError={(e) => {
          e.target.onerror = null;
          e.target.src = LOCAL_EVENT_FALLBACK.imageUrl;
        }}
      />
      <div className="event-banner-overlay" style={{ opacity: isFading ? 0 : 1, transition: 'opacity 0.5s ease-in-out' }}>
        <div>
          {eventData.title ? <div className="event-banner-title">{eventData.title}</div> : null}
          {eventData.date ? <div className="event-banner-date">{eventData.date}</div> : null}
        </div>
      </div>
    </div>
  );
};

export default EventBanner;
