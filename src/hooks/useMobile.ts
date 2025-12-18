import { useState, useEffect } from 'react';

export const useMobile = (): boolean => {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    // Check if window is available (SSR safety)
    if (typeof window === 'undefined') return false;
    
    // Check user agent for mobile devices
    const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
    const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
    const isMobileUserAgent = mobileRegex.test(userAgent.toLowerCase());
    
    // Also check viewport width
    const isSmallViewport = window.innerWidth <= 768;
    
    // Check for touch capability (more reliable for actual mobile devices)
    const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    
    return (isMobileUserAgent && hasTouchScreen) || (isSmallViewport && hasTouchScreen);
  });

  useEffect(() => {
    const checkMobile = () => {
      const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
      const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
      const isMobileUserAgent = mobileRegex.test(userAgent.toLowerCase());
      const isSmallViewport = window.innerWidth <= 768;
      const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      setIsMobile((isMobileUserAgent && hasTouchScreen) || (isSmallViewport && hasTouchScreen));
    };

    window.addEventListener('resize', checkMobile);
    checkMobile(); // Check on mount

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return isMobile;
};

