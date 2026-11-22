import {useCallback, useEffect, useState} from 'react';
import {RoutePath} from '../types/noodle';

const VALID_ROUTES: RoutePath[] = [
  '/',
  '/workspace',
  '/workspace/study',
  '/workspace/synthesizer',
  '/settings',
  '/diagnostics',
];

function parseHashRoute(): RoutePath {
  if (typeof window === 'undefined') {
    return '/';
  }
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const normalized = raw.startsWith('/') ? raw : `/${raw}`;
  if (VALID_ROUTES.includes(normalized as RoutePath)) {
    return normalized as RoutePath;
  }
  return '/';
}

export function useHashRoute() {
  const [route, setRoute] = useState<RoutePath>(() => parseHashRoute());

  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseHashRoute());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((nextRoute: RoutePath) => {
    const targetHash = `#${nextRoute}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    } else {
      setRoute(nextRoute);
    }
  }, []);

  return {route, navigate};
}
