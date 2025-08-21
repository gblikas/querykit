'use client';

import { PGlite } from '@electric-sql/pglite';
import { PGliteProvider } from '@electric-sql/pglite-react';
import { PGliteWithLive } from '@electric-sql/pglite/live';
import { JSX, useEffect, useState } from 'react';

// Create a PGlite instance with async initialization
let dbInstance: PGlite | null = null;
let isInitializing = false;

const initializeDb = async (): Promise<PGlite> => {
  if (dbInstance) {
    return dbInstance;
  }

  if (isInitializing) {
    // Wait for the current initialization to complete
    while (!dbInstance && isInitializing) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return dbInstance!;
  }

  isInitializing = true;

  try {
    console.log('Initializing PGlite...');
    dbInstance = new PGlite();
    console.log('PGlite initialized successfully');
    return dbInstance;
  } catch (error) {
    console.error('Failed to initialize PGlite:', error);
    throw error;
  } finally {
    isInitializing = false;
  }
};

export function Providers({
  children
}: {
  children: React.ReactNode;
}): JSX.Element {
  const [db, setDb] = useState<PGlite | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const setupDb = async (): Promise<void> => {
      try {
        const database = await initializeDb();
        setDb(database);
        setIsReady(true);
      } catch (error) {
        console.error('Database initialization failed:', error);
      }
    };

    void setupDb();
  }, []);

  if (!isReady || !db) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-center">
          <div className="text-lg font-semibold">Initializing Database...</div>
          <div className="text-sm text-muted-foreground mt-2">
            Setting up PGlite in your browser
          </div>
        </div>
      </div>
    );
  }

  return (
    <PGliteProvider db={db as unknown as PGliteWithLive}>
      {children}
    </PGliteProvider>
  );
}
