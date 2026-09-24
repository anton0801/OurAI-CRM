'use client';
import { useEffect, useState } from 'react';

export const useDebounced = <T,>(value: T, ms = 250): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};
