import React, { useCallback, useState } from 'react';
import { Outlet } from 'react-router-dom';
import AppSidebar, { readSidebarCollapsed, writeSidebarCollapsed } from './AppSidebar';

const AppShell: React.FC = () => {
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);

  const onToggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  }, []);

  const onExpandSidebar = useCallback(() => {
    setCollapsed((prev) => {
      if (!prev) return prev;
      writeSidebarCollapsed(false);
      return false;
    });
  }, []);

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ backgroundColor: 'var(--bg)' }}
    >
      <AppSidebar
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        onExpandSidebar={onExpandSidebar}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
};

export default AppShell;
