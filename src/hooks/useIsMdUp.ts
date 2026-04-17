import { useEffect, useState } from 'react';

const MD_QUERY = '(min-width: 768px)';

export function useIsMdUp(): boolean {
  const [isMdUp, setIsMdUp] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(MD_QUERY).matches : true
  );

  useEffect(() => {
    const mq = window.matchMedia(MD_QUERY);
    const onChange = () => setIsMdUp(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMdUp;
}
