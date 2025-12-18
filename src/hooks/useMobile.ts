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
    
    return isMobileUserAgent || isSmallViewport;
  });

  useEffect(() => {
    const checkMobile = () => {
      const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
      const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
      const isMobileUserAgent = mobileRegex.test(userAgent.toLowerCase());
      const isSmallViewport = window.innerWidth <= 768;
      setIsMobile(isMobileUserAgent || isSmallViewport);
    };

    window.addEventListener('resize', checkMobile);
    checkMobile(); // Check on mount

    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return isMobile;
};

