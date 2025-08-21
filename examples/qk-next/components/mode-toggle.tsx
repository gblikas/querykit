'use client';

import * as React from 'react';
import { Sunrise, Sunset } from 'lucide-react';
import { useTheme } from 'next-themes';

export function ModeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  const handleToggle = React.useCallback(() => {
    const next = resolvedTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }, [resolvedTheme, setTheme]);

  return (
    <button
      type="button"
      onClick={handleToggle}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-accent transition-colors"
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      <Sunset className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Sunrise className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
    </button>
  );
}
