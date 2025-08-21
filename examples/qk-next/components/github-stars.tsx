'use client';

import * as React from 'react';
import { Icons } from '@/components/ui/icons';

type StarsResponse = {
  stargazers_count?: number;
};

export function GitHubStars() {
  const [stars, setStars] = React.useState<number | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(true);

  React.useEffect(() => {
    let isMounted = true;
    const fetchStars = async () => {
      try {
        const res = await fetch(
          'https://api.github.com/repos/gblikas/querykit',
          {
            headers: { Accept: 'application/vnd.github+json' },
            cache: 'force-cache'
          }
        );
        const data: StarsResponse = await res.json();
        if (isMounted) {
          const count =
            typeof data.stargazers_count === 'number'
              ? data.stargazers_count
              : null;
          setStars(count);
        }
      } catch {
        if (isMounted) setStars(null);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    void fetchStars();
    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <span className="inline-flex items-center gap-1">
      <Icons.gitHub className="h-4 w-4" aria-hidden="true" />
      {isLoading ? <span>—</span> : <span>{stars ?? '—'}</span>}
    </span>
  );
}
