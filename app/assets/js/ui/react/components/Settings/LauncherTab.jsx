import React, { useState, useEffect } from 'react';

const LauncherTab = () => {
  const [dataDir, setDataDir] = useState('');
  const [allowPrerelease, setAllowPrerelease] = useState(false);

  useEffect(() => {
    if (window.ConfigManager) {
      setDataDir(window.ConfigManager.getDataDirectory() || '');
      setAllowPrerelease(window.ConfigManager.getAllowPrerelease() || false);
    }
  }, []);

  const handleDataDirChange = (e) => {
    setDataDir(e.target.value);
    if (window.ConfigManager) {
      window.ConfigManager.setDataDirectory(e.target.value);
      window.ConfigManager.save().catch(err => console.error('[LauncherTab] ConfigManager save failed:', err));
    }
  };

  const handlePrereleaseToggle = () => {
    const newVal = !allowPrerelease;
    setAllowPrerelease(newVal);
    if (window.ConfigManager) {
      window.ConfigManager.setAllowPrerelease(newVal);
      window.ConfigManager.save().catch(err => console.error('[LauncherTab] ConfigManager save failed:', err));
    }
  };

  return (
    <div style={{ maxWidth: '800px' }}>
      <h1 style={{ marginBottom: '5px' }}>Настройки лаунчера</h1>
      <p style={{ opacity: 0.6, marginBottom: '40px' }}>Параметры, связанные с поведением лаунчера.</p>

      {/* Prerelease */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', paddingBottom: '30px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <div>
          <h3 style={{ marginBottom: '5px' }}>Плавающий релиз</h3>
          <p style={{ opacity: 0.6, fontSize: '0.9em', maxWidth: '500px' }}>
            Получайте новые функции и исправления сразу после их тестирования, не дожидаясь основного релиза.
          </p>
        </div>
        <div 
          onClick={handlePrereleaseToggle}
          style={{
            width: '50px',
            height: '26px',
            background: allowPrerelease ? 'var(--react-accent)' : 'rgba(255,255,255,0.2)',
            borderRadius: '13px',
            cursor: 'pointer',
            position: 'relative',
            transition: 'background 0.3s'
          }}
        >
          <div style={{
            position: 'absolute',
            top: '3px',
            left: allowPrerelease ? '27px' : '3px',
            width: '20px',
            height: '20px',
            background: 'white',
            borderRadius: '50%',
            transition: 'left 0.3s'
          }}></div>
        </div>
      </div>

      {/* Data Directory */}
      <div style={{ marginBottom: '30px', paddingBottom: '30px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <h3 style={{ marginBottom: '15px' }}>Каталог данных</h3>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input 
            type="text" 
            value={dataDir}
            onChange={handleDataDirChange}
            style={{
              flex: 1,
              padding: '12px 15px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: 'white',
              fontFamily: 'inherit',
              outline: 'none'
            }}
          />
          <button style={{
            padding: '12px 20px',
            background: 'rgba(255,255,255,0.1)',
            border: 'none',
            borderRadius: '8px',
            color: 'white',
            cursor: 'pointer',
            fontWeight: '600'
          }}>
            Выбрать папку
          </button>
        </div>
        <p style={{ opacity: 0.6, fontSize: '0.85em', marginTop: '15px' }}>
          Все игровые файлы и локальные установки Java будут храниться в этом каталоге.
        </p>
      </div>
    </div>
  );
};

export default LauncherTab;
