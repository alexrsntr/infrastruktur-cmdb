import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ColorMode } from '../theme';

/** What the user chose: a fixed scheme or "follow the operating system". */
export type ColorModePreference = ColorMode | 'system';

const STORAGE_KEY = 'cmdb.colorMode';
const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

function readPreference(): ColorModePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage blocked */
  }
  return 'system';
}

interface ColorModeValue {
  preference: ColorModePreference;
  /** The scheme actually shown */
  mode: ColorMode;
  setPreference: (p: ColorModePreference) => void;
}

const ColorModeContext = createContext<ColorModeValue>({ preference: 'system', mode: 'light', setPreference: () => undefined });

export function useColorModeState(): ColorModeValue {
  const [preference, setPreferenceState] = useState<ColorModePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(() => !!media()?.matches);

  useEffect(() => {
    const mq = media();
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const mode: ColorMode = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  return useMemo(
    () => ({
      preference,
      mode,
      setPreference: (p: ColorModePreference) => {
        setPreferenceState(p);
        try {
          localStorage.setItem(STORAGE_KEY, p);
        } catch {
          /* storage blocked */
        }
      },
    }),
    [preference, mode],
  );
}

export const ColorModeProvider = ColorModeContext.Provider;

export function useColorMode(): ColorModeValue {
  return useContext(ColorModeContext);
}
