"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  intlLocale,
  isAppLocale,
  LOCALE_STORAGE_KEY,
  translate,
  type AppLocale,
} from "@/lib/i18n";

type TranslationValue = string | number;

interface LocaleContextValue {
  locale: AppLocale;
  numberLocale: "en-US" | "zh-CN";
  setLocale(locale: AppLocale): void;
  t(source: string, values?: Record<string, TranslationValue>): string;
}

const localeListeners = new Set<() => void>();

function readBrowserLocale(): AppLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return isAppLocale(stored) ? stored : DEFAULT_LOCALE;
}

function subscribeToLocale(listener: () => void) {
  localeListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LOCALE_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    localeListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  numberLocale: intlLocale(DEFAULT_LOCALE),
  setLocale: () => undefined,
  t: (source, values) => translate(DEFAULT_LOCALE, source, values),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(
    subscribeToLocale,
    readBrowserLocale,
    () => DEFAULT_LOCALE,
  );

  const setLocale = useCallback((nextLocale: AppLocale) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    localeListeners.forEach((listener) => listener());
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      numberLocale: intlLocale(locale),
      setLocale,
      t: (source, values) => translate(locale, source, values),
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}
