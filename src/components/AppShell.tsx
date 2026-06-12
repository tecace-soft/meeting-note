import React, { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { WindowSidebar } from 'react-coolicons';
import { IconButton } from '../ui/wantedCompat';
import AppSidebar, {
  readMobileSidebarCollapsed,
  readSidebarCollapsed,
  writeMobileSidebarCollapsed,
  writeSidebarCollapsed,
} from './AppSidebar';
import { useIsMdUp } from '../hooks/useIsMdUp';
import FloatingRecorderWidget from './FloatingRecorderWidget';
import { RecorderProvider } from '../context/RecorderContext';

function readInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(min-width: 768px)').matches) {
      return readSidebarCollapsed();
    }
    return readMobileSidebarCollapsed();
  } catch {
    return false;
  }
}

const AppShell: React.FC = () => {
  const isMdUp = useIsMdUp();
  const [collapsed, setCollapsed] = useState(readInitialCollapsed);
  const mobileOverlay = !isMdUp;

  const persistCollapsed = useCallback((next: boolean) => {
    if (typeof window === 'undefined') return;
    const desktop = window.matchMedia('(min-width: 768px)').matches;
    if (desktop) writeSidebarCollapsed(next);
    else writeMobileSidebarCollapsed(next);
  }, []);

  const onToggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      persistCollapsed(next);
      return next;
    });
  }, [persistCollapsed]);

  const onExpandSidebar = useCallback(() => {
    setCollapsed((prev) => {
      if (!prev) return prev;
      persistCollapsed(false);
      return false;
    });
  }, [persistCollapsed]);

  const onMobileOverlayNavigate = useCallback(() => {
    setCollapsed(true);
    persistCollapsed(true);
  }, [persistCollapsed]);

  useEffect(() => {
    if (isMdUp || collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCollapsed(true);
        persistCollapsed(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMdUp, collapsed, persistCollapsed]);

  return (
    <RecorderProvider>
      <div
        className="relative flex h-screen w-full overflow-hidden"
        style={{ backgroundColor: 'var(--bg)' }}
      >
        <AppSidebar
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          onExpandSidebar={onExpandSidebar}
          mobileOverlay={mobileOverlay}
          onMobileOverlayNavigate={onMobileOverlayNavigate}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>

        <FloatingRecorderWidget />

        {mobileOverlay && collapsed ? (
          <div
            className="fixed z-30 md:hidden"
            style={{
              bottom: 'max(0.75rem, env(safe-area-inset-bottom))',
              left: 'max(0.75rem, env(safe-area-inset-left))',
            }}
          >
            <IconButton
              type="button"
              variant="solid"
              aria-label="Open menu"
              onClick={() => {
                setCollapsed(false);
                persistCollapsed(false);
              }}
            >
              <WindowSidebar width={22} height={22} aria-hidden />
            </IconButton>
          </div>
        ) : null}

        {mobileOverlay && !collapsed ? (
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default bg-black/40 md:hidden"
            aria-label="Close menu"
            onClick={() => {
              setCollapsed(true);
              persistCollapsed(true);
            }}
          />
        ) : null}
      </div>
    </RecorderProvider>
  );
};

export default AppShell;
