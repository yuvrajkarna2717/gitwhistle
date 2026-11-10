import { useEffect, useState } from 'react';

/** Transient success/error feedback: setFlash({ message, tone? }) shows a notice that auto-clears. */
export function useFlash(timeout = 4000) {
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), timeout);
    return () => clearTimeout(t);
  }, [flash, timeout]);
  return [flash, setFlash];
}
