import { useCallback, useEffect, useRef, useState } from "react";

export function useDebouncedCallback<T extends (...args: never[]) => void>(callback: T, delayMs: number): T {
  const timeout = useRef<number | undefined>(undefined);
  const latest = useRef(callback);
  latest.current = callback;

  return useCallback(((...args: Parameters<T>) => {
    window.clearTimeout(timeout.current);
    timeout.current = window.setTimeout(() => latest.current(...args), delayMs);
  }) as T, [delayMs]);
}

export function useLocalStorage<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}
