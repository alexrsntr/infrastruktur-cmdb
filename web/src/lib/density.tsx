import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Density } from '../../../shared/appearance';

/** What the user chose: a fixed density or the organisation's default (Administration → Settings → Appearance). */
export type DensityPreference = Density | 'default';

const STORAGE_KEY = 'cmdb.density';

function readPreference(): DensityPreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'comfortable' || v === 'compact' || v === 'default') return v;
  } catch {
    /* storage blocked */
  }
  return 'default';
}

interface DensityValue {
  preference: DensityPreference;
  /** The density actually shown */
  density: Density;
  /** The organisation's default */
  orgDefault: Density;
  setPreference: (p: DensityPreference) => void;
}

const DensityContext = createContext<DensityValue>({ preference: 'default', density: 'comfortable', orgDefault: 'comfortable', setPreference: () => undefined });

export function useDensityState(orgDefault: Density): DensityValue {
  const [preference, setPreferenceState] = useState<DensityPreference>(readPreference);
  const density: Density = preference === 'default' ? orgDefault : preference;

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  return useMemo(
    () => ({
      preference,
      density,
      orgDefault,
      setPreference: (p: DensityPreference) => {
        setPreferenceState(p);
        try {
          localStorage.setItem(STORAGE_KEY, p);
        } catch {
          /* storage blocked */
        }
      },
    }),
    [preference, density, orgDefault],
  );
}

export const DensityProvider = DensityContext.Provider;

export function useDensity(): DensityValue {
  return useContext(DensityContext);
}
