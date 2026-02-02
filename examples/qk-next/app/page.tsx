'use client';

import { useEffect, useMemo, useState, useCallback, useRef, JSX } from 'react';
import { drizzle } from 'drizzle-orm/pglite';
import { usePGlite } from '@electric-sql/pglite-react';
import { pgTable, serial, text, integer, boolean } from 'drizzle-orm/pg-core';
import { InferSelectModel, sql, SQLWrapper } from 'drizzle-orm';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import {
  QueryParser,
  SqlTranslator,
  DrizzleAdapter,
  createQueryKit,
  IDrizzleAdapterOptions,
  parseQueryTokens
} from '@gblikas/querykit';
import { Copy, Check, Search, ChevronUp, FileCode, X } from 'lucide-react';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomOneDarkReasonable } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import sqlLanguage from 'react-syntax-highlighter/dist/esm/languages/hljs/sql';
import typescriptLanguage from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import bashLanguage from 'react-syntax-highlighter/dist/esm/languages/hljs/bash';
// json language no longer needed as EXPLAIN view is removed
import { toast } from 'sonner';
import Aurora from '@/components/reactbits/blocks/Backgrounds/Aurora/Aurora';
import { PGlite } from '@electric-sql/pglite';
import { useViewportInfo } from './hooks/use-viewport-info';
import {
  cn,
  trackQueryKitIssue,
  trackQueryKitUsage,
  trackQueryKitSpeed
} from '@/lib/utils';
import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerClose
} from '@/components/ui/drawer';

// Escape HTML entities for safe rendering
const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Highlight query input using QueryKit's parseQueryTokens for accurate tokenization.
 * This provides robust key:value highlighting that handles:
 * - Comparison operators (:, :>, :>=, :<, :<=, :!=)
 * - Logical operators (AND, OR, NOT)
 * - Quoted values
 * - Negation prefixes
 */
const highlightQueryHtml = (input: string): string => {
  if (!input) return '';

  const result = parseQueryTokens(input);
  const tokens = result.tokens;

  if (tokens.length === 0) {
    return escapeHtml(input);
  }

  let html = '';
  let lastEnd = 0;

  for (const token of tokens) {
    // Add any whitespace/text between tokens
    if (token.startPosition > lastEnd) {
      html += escapeHtml(input.slice(lastEnd, token.startPosition));
    }

    if (token.type === 'operator') {
      // Logical operator (AND, OR, NOT) - style in purple
      html += `<span class="text-purple-400 font-medium">${escapeHtml(token.operator)}</span>`;
    } else if (token.type === 'term') {
      // Term token - check if it has key:value structure
      if (token.key !== null && token.operator !== null) {
        // Key:value term
        // Detect negation from key prefix (e.g., "-status" means negated)
        const isNegated = token.key.startsWith('-');
        const displayKey = isNegated ? token.key.slice(1) : token.key;
        const opPart = token.operator;
        const valuePart = token.value !== null ? String(token.value) : '';

        // Build the highlighted term
        if (isNegated) {
          html += `<span class="text-red-400">-</span>`;
        }
        html += `<span class="text-orange-400">${escapeHtml(displayKey)}</span>`;
        html += `<span class="text-gray-500">${escapeHtml(opPart)}</span>`;
        if (valuePart) {
          // Check if it was quoted in original input
          const rawValue = token.raw.slice(
            (isNegated ? 1 : 0) + displayKey.length + opPart.length
          );
          html += `<span class="text-blue-400 bg-blue-500/20 rounded">${escapeHtml(rawValue)}</span>`;
        }
      } else {
        // Bare value (no key)
        const text = token.raw;
        // Detect negation from raw text prefix
        const isNegated = text.startsWith('-');
        if (isNegated) {
          html += `<span class="text-red-400">-</span>${escapeHtml(text.slice(1))}`;
        } else {
          html += escapeHtml(text);
        }
      }
    }

    lastEnd = token.endPosition;
  }

  // Add any trailing text
  if (lastEnd < input.length) {
    html += escapeHtml(input.slice(lastEnd));
  }

  return html;
};

const INSTALL_SNIPPET = `pnpm i @gblikas/querykit drizzle-orm`;

const SCHEMA_SNIPPET = `// schema.ts
import { serial, text, pgTable } from 'drizzle-orm/pg-core';
import { InferSelectModel } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('draft'),
});

export type SelectUser = InferSelectModel<typeof users>;
`;

const QUERYKIT_SNIPPET = `// querykit.ts
import { createQueryKit } from 'querykit';
import { drizzleAdapter } from 'querykit/adapters/drizzle';
import { users } from './schema';

export const qk = createQueryKit({
  adapter: drizzleAdapter,
  schema: { users },
});

// example.ts
import { qk } from './querykit';

const query = qk
  .query('users')
  .where('status:done AND name:"John *"')
  .orderBy('name', 'asc')
  .limit(10);

const results = await query.execute();
`;

const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  priority: integer('priority').default(0).notNull(),
  completed: boolean('completed').default(false).notNull()
});

type Task = InferSelectModel<typeof tasks>;

export default function Home(): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Task[]>([]);
  const [dbReady, setDbReady] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] =
    useState<number>(-1);
  const [lastExecutedQuery, setLastExecutedQuery] = useState('');
  const [generatedSQL, setGeneratedSQL] = useState('SELECT * FROM tasks');
  const [, setLastExecutionMs] = useState<number | null>(null);
  const [rowsScanned, setRowsScanned] = useState<number | null>(null);
  const [operatorsUsed, setOperatorsUsed] = useState<string[]>([]);
  const [usedQueryKit, setUsedQueryKit] = useState<boolean>(false);
  const [, setExplainJson] = useState<string | null>(null);
  const [, setPlanningTimeMs] = useState<number | null>(null);
  const [, setExecutionTimeMs] = useState<number | null>(null);
  const [, setExplainError] = useState<string | null>(null);
  const [dbExecutionMs, setDbExecutionMs] = useState<number | null>(null);
  const [, setParseTranslateMs] = useState<number | null>(null);
  const [, setExplainLatencyMs] = useState<number | null>(null);
  const [, setBaselineFetchMs] = useState<number | null>(null);
  const [hasCopiedSql, setHasCopiedSql] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  // EXPLAIN view removed
  const [isResultsOpen, setIsResultsOpen] = useState(false);
  const sqlCardAnchorRef = useRef<HTMLDivElement | null>(null);
  const [drawerTopPx, setDrawerTopPx] = useState<number>(0);
  const cardContentRef = useRef<HTMLDivElement | null>(null);
  const [cardMaxHeightPx, setCardMaxHeightPx] = useState<number | null>(null);
  const COPY_FEEDBACK_MS = 2000;

  const quickStartSections = useMemo(
    () => [
      {
        id: 'install',
        title: 'Install QueryKit',
        description:
          'Pull in QueryKit and the Drizzle adapter so you can follow along locally.',
        code: INSTALL_SNIPPET,
        language: 'bash'
      },
      {
        id: 'schema',
        title: 'Define your schema (schema.ts)',
        description:
          'Describe the table you want to search—QueryKit uses this shape to parse queries.',
        code: SCHEMA_SNIPPET,
        language: 'typescript'
      },
      {
        id: 'usage',
        title: 'Create QueryKit and run a search',
        description:
          'Instantiate QueryKit, build a Lucene-style query, and execute it against your DB.',
        code: QUERYKIT_SNIPPET,
        language: 'typescript'
      }
    ],
    []
  );

  // Viewport info for small-height detection
  const { isShortSideLessThan } = useViewportInfo();
  const isShortViewport = isShortSideLessThan(390);

  // Respect a ?drawer=open query param so the quick-start drawer can be shared
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const search = new URLSearchParams(window.location.search);
    if (search.get('drawer') === 'open') {
      setIsDrawerOpen(true);
    }
  }, []);

  // Register languages once
  useEffect(() => {
    try {
      const highlighter = SyntaxHighlighter as typeof SyntaxHighlighter & {
        registerLanguage: (name: string, language: unknown) => void;
      };
      highlighter.registerLanguage('sql', sqlLanguage);
      highlighter.registerLanguage('typescript', typescriptLanguage);
      highlighter.registerLanguage('bash', bashLanguage);
    } catch (error) {
      console.error('Failed to register languages:', error);
    }
  }, []);

  // Pretty-print SQL by placing major clauses and boolean operators on new lines
  const formatSqlForDisplay = useCallback((sqlText: string): string => {
    if (!sqlText) return '';
    let compact = sqlText.replace(/\s+/g, ' ').trim();
    const clauseKeywords = [
      'FROM',
      'WHERE',
      'GROUP BY',
      'HAVING',
      'ORDER BY',
      'LIMIT',
      'OFFSET'
    ];
    for (const kw of clauseKeywords) {
      const re = new RegExp(`\\s+${kw}\\b`, 'gi');
      compact = compact.replace(re, `\n${kw}`);
    }
    compact = compact.replace(
      /\s+(LEFT|RIGHT|FULL|INNER|CROSS)?\s*JOIN\b/gi,
      match => `\n${match.trim().toUpperCase()}`
    );
    compact = compact.replace(/\s+ON\b/gi, '\nON');
    compact = compact.replace(/\s+(AND|OR)\s+/gi, '\n  $1 ');
    return compact;
  }, []);

  const formattedSQL = useMemo(
    () => formatSqlForDisplay(generatedSQL),
    [generatedSQL, formatSqlForDisplay]
  );

  // Static suggestions for keyboard navigation
  const suggestions = useMemo(
    () => [
      { q: 'status:done', desc: 'Find completed tasks' },
      { q: 'priority:>=2', desc: 'High priority tasks' },
      { q: 'status:doing AND priority:<3', desc: 'In-progress, low priority' },
      { q: 'title:docs OR title:ship', desc: 'Documentation or shipping' },
      { q: 'NOT completed:true', desc: 'Incomplete tasks' }
    ],
    []
  );

  // Use the PGlite instance from context
  const pglite = usePGlite();
  const db = useMemo(() => drizzle(pglite as unknown as PGlite), [pglite]);

  useEffect(() => {
    const seed = async (): Promise<void> => {
      try {
        console.log('Seeding database...');
        await db.execute(sql`
          create table if not exists tasks (
            id serial primary key,
            title text not null,
            status text not null,
            priority integer not null default 0,
            completed boolean not null default false
          );
        `);
        const existing = await db.select().from(tasks).limit(1);
        if (existing.length === 0) {
          await db.insert(tasks).values([
            {
              title: 'Write docs',
              status: 'todo',
              priority: 2,
              completed: false
            },
            {
              title: 'Ship alpha',
              status: 'doing',
              priority: 1,
              completed: false
            },
            {
              title: 'Fix bugs',
              status: 'doing',
              priority: 3,
              completed: false
            },
            { title: 'Publish', status: 'done', priority: 1, completed: true }
          ]);
        }
        console.log('Database seeded successfully');

        // Load initial data and show default query details
        const data = await db.select().from(tasks);
        setResults(data as Task[]);
        setRowsScanned(data.length);
        setLastExecutedQuery('(default)');
        setGeneratedSQL('SELECT * FROM tasks');
        setDbReady(true);
      } catch (error) {
        console.error('Database seeding failed:', error);
      }
    };
    void seed();
  }, [db]);

  const parser = useMemo(() => new QueryParser(), []);
  const sqlTranslator = useMemo(
    () => new SqlTranslator({ useParameters: false }),
    []
  );
  const qk = useMemo(() => {
    const adapter = new DrizzleAdapter();
    const iDrizzleAdataperOptions: IDrizzleAdapterOptions = {
      db: db as unknown as PGlite,
      schema: { tasks } as unknown as Record<string, Record<string, SQLWrapper>>
    };
    adapter.initialize(iDrizzleAdataperOptions);
    return createQueryKit({
      adapter,
      schema: { tasks } as unknown as Record<string, Record<string, SQLWrapper>>
    });
  }, [db]);

  // Note: Execute via QueryKit fluent API (Drizzle adapter under the hood)

  // Execute search function
  const executeSearch = useCallback(
    async (searchQuery: string) => {
      if (!dbReady) return;

      setIsSearching(true);
      setQuery(searchQuery); // Keep the query in the input field
      setIsSuggestionsOpen(false);
      setActiveSuggestionIndex(-1);
      setIsInputFocused(false);
      inputRef.current?.blur();
      setOperatorsUsed([]);
      setExplainJson(null);
      setPlanningTimeMs(null);
      setExecutionTimeMs(null);
      setExplainError(null);
      setDbExecutionMs(null);
      setParseTranslateMs(null);
      setExplainLatencyMs(null);
      setBaselineFetchMs(null);
      const started = performance.now();
      let baselineMs: number | null = null;
      let localParseTranslateMs: number | null = null;
      let localExplainLatencyMs: number | null = null;
      let localDbExecutionMs: number | null = null;
      let localRowsScanned: number | null = null;

      try {
        // Get all tasks count/base for messaging
        const baselineStart = performance.now();
        const allTasks = await db.select().from(tasks);
        baselineMs = performance.now() - baselineStart;
        setBaselineFetchMs(baselineMs);
        localRowsScanned = allTasks.length;
        setRowsScanned(localRowsScanned);

        // Use QueryKit fluent API to execute the query
        let filteredTasks: Task[] = allTasks as Task[];
        let wasQueryKitUsed = false;
        if (searchQuery.trim()) {
          try {
            filteredTasks = (await qk
              .query('tasks')
              .where(searchQuery)
              .execute()) as Task[];
            wasQueryKitUsed = true;
          } catch (error) {
            console.warn(
              'Query execution failed, falling back to simple search:',
              error
            );
            void trackQueryKitIssue({
              errorName: (error as Error)?.name ?? 'UnknownError',
              errorMessage: (error as Error)?.message ?? 'Unknown',
              stage: 'execute',
              query: searchQuery
            });
            const searchTerm = searchQuery.toLowerCase();
            filteredTasks = (allTasks as Task[]).filter(
              task =>
                task.title.toLowerCase().includes(searchTerm) ||
                task.status.toLowerCase().includes(searchTerm)
            );
          }
        }

        // Generate SQL from QueryKit for display
        let mockSQL = 'SELECT * FROM tasks';
        let detectedOperators: string[] = [];
        let whereSql: string | null = null;
        if (searchQuery.trim()) {
          try {
            const parseStart = performance.now();
            const ast = parser.parse(searchQuery);
            const translated = sqlTranslator.translate(ast) as
              | string
              | { sql: string; params: unknown[] };
            localParseTranslateMs = performance.now() - parseStart;
            setParseTranslateMs(localParseTranslateMs);
            whereSql =
              typeof translated === 'string' ? translated : translated.sql;
            mockSQL += ` WHERE ${whereSql}`;
            // Robust operator detection with word boundaries and precedence
            const extractOperators = (sqlText: string): string[] => {
              const found = new Set<string>();
              const upper = sqlText.toUpperCase();
              // Keyword operators (use word boundaries)
              const keywordOps: Array<[string, RegExp]> = [
                ['ILIKE', /\bILIKE\b/i],
                ['LIKE', /\bLIKE\b/i],
                ['AND', /\bAND\b/i],
                ['OR', /\bOR\b/i],
                ['NOT', /\bNOT\b/i],
                ['IN', /\bIN\b/i],
                ['BETWEEN', /\bBETWEEN\b/i]
              ];
              for (const [name, re] of keywordOps) {
                if (re.test(sqlText)) found.add(name);
              }
              // Symbol operators: match longest first and remove before shorter matches
              let temp = upper;
              const consume = (re: RegExp, label: string): void => {
                if (re.test(temp)) {
                  found.add(label);
                  temp = temp.replace(re, ' ');
                }
              };
              consume(/>=/g, '>=');
              consume(/<=/g, '<=');
              consume(/!=/g, '!=');
              consume(/=/g, '=');
              consume(/>/g, '>');
              consume(/</g, '<');
              return Array.from(found);
            };
            detectedOperators = extractOperators(whereSql);
          } catch (error) {
            void trackQueryKitIssue({
              errorName: (error as Error)?.name ?? 'UnknownError',
              errorMessage: (error as Error)?.message ?? 'Unknown',
              stage: 'translate',
              query: searchQuery
            });
            mockSQL += ` WHERE title ILIKE '%${searchQuery}%' OR status ILIKE '%${searchQuery}%'`;
            detectedOperators = ['ILIKE'];
          }
        }

        setResults(filteredTasks);
        setLastExecutedQuery(searchQuery.trim() ? searchQuery : '(default)');
        setGeneratedSQL(mockSQL);
        setUsedQueryKit(wasQueryKitUsed);
        const uniqueOperators = Array.from(new Set(detectedOperators));
        void trackQueryKitUsage({
          usedQueryKit: wasQueryKitUsed,
          operators: uniqueOperators
        });
        setOperatorsUsed(uniqueOperators);

        // Try to run EXPLAIN ANALYZE to capture a plan (JSON format for easy parsing)
        try {
          const fullSql = mockSQL;
          // Drizzle execute with raw SQL. PGlite should support EXPLAIN.
          const explainCmd = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${fullSql}`;
          const explainStart = performance.now();
          const explainRows = await db.execute(sql.raw(explainCmd));
          localExplainLatencyMs = performance.now() - explainStart;
          setExplainLatencyMs(localExplainLatencyMs);
          // Shape can vary. Try common Postgres JSON format: [{ "QUERY PLAN": [ { Plan: {...}, Planning Time: n, Execution Time: n } ] }]
          const firstRow = Array.isArray(explainRows)
            ? explainRows[0]
            : (explainRows?.rows?.[0] ?? explainRows);
          const planContainer =
            firstRow?.['QUERY PLAN'] ?? firstRow?.query_plan ?? firstRow;
          const jsonRoot = Array.isArray(planContainer)
            ? planContainer[0]
            : planContainer;
          if (jsonRoot) {
            const planning =
              typeof jsonRoot['Planning Time'] === 'number'
                ? jsonRoot['Planning Time']
                : (jsonRoot?.PlanningTime ?? null);
            const execution =
              typeof jsonRoot['Execution Time'] === 'number'
                ? jsonRoot['Execution Time']
                : (jsonRoot?.ExecutionTime ?? null);
            if (typeof planning === 'number') setPlanningTimeMs(planning);
            if (typeof execution === 'number') setExecutionTimeMs(execution);
            if (typeof execution === 'number') {
              localDbExecutionMs = execution;
              setDbExecutionMs(execution);
            }
            setExplainJson(JSON.stringify(jsonRoot, null, 2));
          } else {
            // Some drivers return text rows when FORMAT JSON is not supported
            const textPlan =
              firstRow?.['QUERY PLAN'] ??
              firstRow?.explain ??
              String(explainRows ?? '');
            setExplainJson(
              typeof textPlan === 'string'
                ? textPlan
                : JSON.stringify(textPlan, null, 2)
            );
          }
        } catch (error) {
          void trackQueryKitIssue({
            errorName: (error as Error)?.name ?? 'UnknownError',
            errorMessage: (error as Error)?.message ?? 'Unknown',
            stage: 'explain'
          });
          setExplainError('EXPLAIN not available');
        }

        const elapsed = performance.now() - started;
        setLastExecutionMs(elapsed);
        // Emit speed telemetry
        void trackQueryKitSpeed({
          usedQueryKit: wasQueryKitUsed,
          baselineMs,
          parseTranslateMs: localParseTranslateMs,
          explainLatencyMs: localExplainLatencyMs,
          dbExecutionMs: localDbExecutionMs,
          totalMs: elapsed,
          rowsScanned: localRowsScanned,
          results: filteredTasks.length
        });

        if (searchQuery.trim()) {
          toast(
            `QueryKit parsed and filtered ${allTasks.length} rows → ${filteredTasks.length} results in ${elapsed.toFixed(1)} ms`
          );
        } else {
          toast(`Showing all ${allTasks.length} rows`);
        }
      } catch (error) {
        console.error('Search failed:', error);
        void trackQueryKitIssue({
          errorName: (error as Error)?.name ?? 'UnknownError',
          errorMessage: (error as Error)?.message ?? 'Unknown',
          stage: 'search'
        });
        toast('Search failed');
      } finally {
        setIsSearching(false);
      }
    },
    [dbReady, db, parser, sqlTranslator, qk]
  );

  // Handle input change (just updates query state)
  const handleSearchChange = useCallback(
    (value: string) => {
      setQuery(value);
      setIsSuggestionsOpen(true);
      if (!isInputFocused) setIsInputFocused(true);
      // Do not auto-select a suggestion when empty; allow user to choose via arrows
      setActiveSuggestionIndex(-1);
    },
    [isInputFocused]
  );

  // Handle Enter key press to execute search
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsSuggestionsOpen(false);
        setActiveSuggestionIndex(-1);
        setIsInputFocused(false);
        inputRef.current?.blur();
        return;
      }
      if (event.key === 'ArrowDown') {
        if (!isSuggestionsOpen) return;
        event.preventDefault();
        setActiveSuggestionIndex(prev => {
          const next = prev < suggestions.length - 1 ? prev + 1 : 0;
          return next;
        });
        return;
      }
      if (event.key === 'ArrowUp') {
        if (!isSuggestionsOpen) return;
        event.preventDefault();
        setActiveSuggestionIndex(prev => {
          const next = prev > 0 ? prev - 1 : suggestions.length - 1;
          return next;
        });
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const trimmed = query.trim();
        if (trimmed.length === 0) {
          // Clear to default dataset
          setIsSuggestionsOpen(false);
          setActiveSuggestionIndex(-1);
          void executeSearch('');
          return;
        }
        if (isSuggestionsOpen && activeSuggestionIndex >= 0) {
          const chosen = suggestions[activeSuggestionIndex]?.q ?? query;
          setIsSuggestionsOpen(false);
          setActiveSuggestionIndex(-1);
          void executeSearch(chosen);
        } else {
          setIsSuggestionsOpen(false);
          void executeSearch(trimmed);
        }
        return;
      }
    },
    [
      query,
      executeSearch,
      isSuggestionsOpen,
      activeSuggestionIndex,
      suggestions
    ]
  );

  // Copy SQL output
  const handleCopySql = useCallback(async () => {
    try {
      const textToCopy = formattedSQL || generatedSQL;
      await navigator.clipboard.writeText(textToCopy);
      toast('SQL copied to clipboard');
      setHasCopiedSql(true);
      window.setTimeout(() => setHasCopiedSql(false), COPY_FEEDBACK_MS);
    } catch {
      toast('Failed to copy SQL');
    }
  }, [formattedSQL, generatedSQL]);

  const handleCopySnippet = useCallback(
    async (id: string, content: string) => {
      try {
        await navigator.clipboard.writeText(content);
        toast('Copied to clipboard');
        setCopiedSnippet(id);
        window.setTimeout(() => setCopiedSnippet(null), COPY_FEEDBACK_MS);
      } catch {
        toast('Failed to copy code');
      }
    },
    [COPY_FEEDBACK_MS]
  );

  // Add Cmd+K keyboard shortcut to focus the inline input
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    document.addEventListener('keydown', down);
    return (): void => document.removeEventListener('keydown', down);
  }, []);

  // Measure the top of the SQL card to set drawer height (covers up to the card's top)
  useEffect(() => {
    const measure = (): void => {
      const el = sqlCardAnchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const top = Math.max(0, rect.top);
      setDrawerTopPx(top);
    };
    const onResize = (): number => requestAnimationFrame(measure);
    measure();
    window.addEventListener('resize', onResize);
    return (): void => window.removeEventListener('resize', onResize);
  }, [lastExecutedQuery]);

  // Cap the entire card content so its bottom does not go past the viewport.
  // The SQL/EXPLAIN viewer becomes the scrollable area that flexes.
  useEffect(() => {
    const measureCard = (): void => {
      const el = cardContentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Align bottom with the floating "Results" button which uses bottom-10 (2.5rem = 40px)
      const RESULTS_BUTTON_BOTTOM_PX = 40;
      const available = Math.max(
        160,
        window.innerHeight - rect.top - RESULTS_BUTTON_BOTTOM_PX
      );
      setCardMaxHeightPx(available);
    };
    const onResize = (): number => requestAnimationFrame(measureCard);
    measureCard();
    window.addEventListener('resize', onResize);
    return (): void => window.removeEventListener('resize', onResize);
  }, [lastExecutedQuery, results.length]);

  return (
    <div className="relative min-h-[100svh] h-[100svh] w-[100svw] overflow-hidden flex flex-col items-center justify-start px-6 bg-transparent pt-[10svh] sm:pt-[33svh]">
      {/* Aurora background */}
      <div className="fixed inset-0 -z-10 pointer-events-none">
        <Aurora amplitude={1.0} blend={0.6} speed={0.4} />
      </div>
      {/* {isInputFocused && (
        <div className="fixed inset-0 z-[5] pointer-events-none">
          <LightRays
            rayLength={3}
            saturation={2}
            lightSpread={.5}
            raysColor="#fff"
          />
        </div>
      )} */}
      <div className="fixed inset-0 z-10 bg-background/60 transition-opacity pointer-events-none" />
      <div className="relative z-20 w-full max-w-3xl space-y-6">
        <div className="text-center mb-2">
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight">
            QueryKit
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground mt-2">
            A type-safe search DSL for React apps. Filter the table and see the
            SQL it generates.
          </p>
        </div>
        <div className="flex justify-center">
          <Drawer
            direction="right"
            open={isDrawerOpen}
            onOpenChange={open => {
              setIsDrawerOpen(open);
              if (!open) {
                setCopiedSnippet(null);
              }
            }}
          >
            <DrawerTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-full bg-transparent px-5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label="Open the QueryKit getting started guide"
              >
                <FileCode className="h-4 w-4" />
                Getting started
              </button>
            </DrawerTrigger>
            <DrawerContent className="data-[vaul-drawer-direction=right]:h-full data-[vaul-drawer-direction=right]:w-full data-[vaul-drawer-direction=right]:max-w-full data-[vaul-drawer-direction=right]:sm:max-w-xl data-[vaul-drawer-direction=right]:rounded-l-3xl">
              <div className="flex h-full flex-col">
                <DrawerHeader className="relative pb-2 text-left px-4 sm:px-6">
                  <DrawerTitle>Get started with QueryKit</DrawerTitle>
                  <DrawerDescription>
                    Install the packages, describe your data, and run your first
                    QueryKit search with the snippets below.
                  </DrawerDescription>
                  <DrawerClose asChild>
                    <button
                      type="button"
                      className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent sm:right-6"
                      aria-label="Close view code drawer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </DrawerClose>
                </DrawerHeader>
                <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4 sm:px-6">
                  {quickStartSections.map(section => (
                    <div key={section.id} className="space-y-2">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">
                          {section.title}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {section.description}
                        </p>
                      </div>
                      <div
                        role="region"
                        aria-label={`${section.title} code example`}
                        className="relative overflow-hidden rounded-md border bg-muted"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            handleCopySnippet(section.id, section.code)
                          }
                          aria-label={`Copy ${section.title}`}
                          title={`Copy ${section.title}`}
                          className={cn(
                            'absolute right-2 inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-muted/60 sm:right-3',
                            section.code.includes('\n')
                              ? 'top-2 sm:top-3'
                              : 'top-1/2 -translate-y-1/2 sm:top-1/2 sm:-translate-y-1/2'
                          )}
                        >
                          <Copy
                            className={`h-4 w-4 transition-all duration-200 ${
                              copiedSnippet === section.id
                                ? 'opacity-0 scale-90'
                                : 'opacity-100 scale-100'
                            }`}
                          />
                          <Check
                            className={`absolute h-4 w-4 text-emerald-500 transition-all duration-200 ${
                              copiedSnippet === section.id
                                ? 'opacity-100 scale-100'
                                : 'opacity-0 scale-110'
                            }`}
                          />
                        </button>
                        <div className="h-full overflow-auto">
                          <SyntaxHighlighter
                            language={section.language}
                            style={atomOneDarkReasonable}
                            wrapLongLines
                            className="quick-start-snippet"
                          >
                            {section.code}
                          </SyntaxHighlighter>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </DrawerContent>
          </Drawer>
        </div>
        {/* Inline search input with recommendation popover */}
        <div className="relative z-50 w-full">
          <div className="flex items-center gap-2 rounded-2xl border bg-background shadow-sm px-3 py-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <div className="relative w-full">
              {/* Highlight overlay behind the input */}
              {query && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 z-0 whitespace-pre text-base leading-[1.25rem] text-foreground/90 flex items-center"
                  dangerouslySetInnerHTML={{
                    __html: highlightQueryHtml(query)
                  }}
                />
              )}
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => handleSearchChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  setIsInputFocused(true);
                  setIsSuggestionsOpen(true);
                }}
                onBlur={e => {
                  const target = e.currentTarget;
                  // Defer blur closing to allow click on suggestions
                  setTimeout(() => {
                    const nextActive =
                      document.activeElement as HTMLElement | null;
                    if (
                      !target ||
                      !nextActive ||
                      !target.contains(nextActive)
                    ) {
                      setIsInputFocused(false);
                      setIsSuggestionsOpen(false);
                    }
                  }, 0);
                }}
                placeholder="Search QueryKit with key:value"
                inputMode="search"
                className={`placeholder:text-muted-foreground relative z-10 flex h-10 w-full rounded-md bg-transparent text-base leading-[1.25rem] outline-none ${query ? 'text-transparent caret-foreground' : ''}`}
              />
            </div>
            <kbd className="bg-muted text-muted-foreground pointer-events-none inline-flex h-5 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium opacity-100 select-none">
              <span className="text-xs">⌘</span>K
            </kbd>
          </div>
          {/* Simple recommendations popover */}
          {isSuggestionsOpen && (
            <div className="absolute left-0 right-0 z-[60] mt-2 rounded-md border bg-popover text-popover-foreground shadow-md">
              <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b">
                QueryKit Examples
              </div>
              <ul
                className="max-h-72 overflow-y-auto py-1"
                role="listbox"
                aria-label="Query suggestions"
              >
                {suggestions.map((s, idx) => (
                  <li
                    key={s.q}
                    role="option"
                    aria-selected={activeSuggestionIndex === idx}
                    className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent ${activeSuggestionIndex === idx ? 'bg-accent' : ''}`}
                    onMouseDown={e => e.preventDefault()}
                    onMouseEnter={() => setActiveSuggestionIndex(idx)}
                    onClick={() => {
                      setIsSuggestionsOpen(false);
                      setActiveSuggestionIndex(-1);
                      executeSearch(s.q);
                    }}
                  >
                    <span
                      className="text-sm"
                      dangerouslySetInnerHTML={{
                        __html: highlightQueryHtml(s.q)
                      }}
                    />
                    <span className="ml-auto text-xs text-muted-foreground">
                      {s.desc}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Query Card (no header) */}
        <div ref={sqlCardAnchorRef} className="w-full">
          <Card className="w-full">
            {lastExecutedQuery && (
              <CardContent>
                <div
                  ref={cardContentRef}
                  className="flex flex-col overflow-hidden"
                  style={{
                    maxHeight: cardMaxHeightPx
                      ? `${cardMaxHeightPx}px`
                      : undefined
                  }}
                >
                  <div className="relative bg-muted p-3 pr-12 rounded-md flex-1 min-h-0">
                    <button
                      type="button"
                      onClick={handleCopySql}
                      aria-label={'Copy SQL'}
                      title={'Copy SQL'}
                      className="absolute top-2 right-2 z-10 inline-flex items-center justify-center rounded-md hover:bg-accent/30 transition-colors h-7 w-7"
                    >
                      <Copy
                        className={`h-4 w-4 transition-all duration-200 ${hasCopiedSql ? 'opacity-0 scale-90' : 'opacity-100 scale-100'}`}
                      />
                      <Check
                        className={`h-4 w-4 absolute transition-all duration-200 ${hasCopiedSql ? 'opacity-100 scale-100' : 'opacity-0 scale-110'}`}
                      />
                    </button>
                    <div className="h-full overflow-auto">
                      <SyntaxHighlighter
                        language={'sql'}
                        style={atomOneDarkReasonable}
                        customStyle={{
                          background: 'transparent',
                          margin: 0,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          overflowWrap: 'anywhere'
                        }}
                        wrapLongLines
                      >
                        {formattedSQL}
                      </SyntaxHighlighter>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    {!isShortViewport && (
                      <div className="rounded-md border p-3 bg-background/50">
                        <div className="text-xs text-muted-foreground">
                          DB time (EXPLAIN)
                        </div>
                        <div className="mt-1 text-base font-medium">
                          {dbExecutionMs !== null
                            ? `${dbExecutionMs.toFixed(3)} ms`
                            : '-'}
                        </div>
                      </div>
                    )}
                    <div className="rounded-md border p-3 bg-background/50">
                      <div className="text-xs text-muted-foreground">
                        Rows returned
                      </div>
                      <div className="mt-1 text-base font-medium">{`${results.length} of ${rowsScanned ?? results.length}`}</div>
                    </div>
                    {!isShortViewport && (
                      <div className="rounded-md border p-3 bg-background/50">
                        <div className="text-xs text-muted-foreground">
                          Engine
                        </div>
                        <div className="mt-1">
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs bg-muted">
                            {usedQueryKit
                              ? 'QueryKit · Drizzle'
                              : 'Client fallback'}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                  {!isShortViewport ? (
                    <div className="mt-3">
                      <div className="text-xs text-muted-foreground mb-1">
                        Detected operators
                      </div>
                      {operatorsUsed.length ? (
                        <div className="flex flex-wrap gap-2">
                          {operatorsUsed.map(op => (
                            <span
                              key={op}
                              className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs font-medium"
                            >
                              {op}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">-</div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-muted-foreground">
                      View on larger screen for more details
                    </div>
                  )}
                </div>
                {/* EXPLAIN has been integrated into the SQL window via the SearchCode toggle */}
              </CardContent>
            )}
          </Card>
        </div>
      </div>

      {/* Toggle button to open results drawer */}
      {!isDrawerOpen && (
        <button
          type="button"
          onClick={() => setIsResultsOpen(v => !v)}
          aria-expanded={isResultsOpen}
          aria-controls="results-drawer"
          title={isResultsOpen ? 'Hide results' : 'Show results'}
          className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[70] inline-flex items-center justify-center rounded-full border bg-background shadow px-3 py-2 text-xs hover:bg-accent transition-colors"
        >
          <ChevronUp
            className={`h-4 w-4 transition-transform ${isResultsOpen ? 'rotate-180' : ''}`}
          />
          <span className="ml-2">{isResultsOpen ? 'Hide' : 'Results'}</span>
        </button>
      )}

      {/* Bottom drawer with results table */}
      {isResultsOpen && (
        <div
          className="fixed inset-0 z-[55]"
          onClick={() => setIsResultsOpen(false)}
        />
      )}

      <div
        id="results-drawer"
        role="dialog"
        aria-label="Query results"
        className={`fixed left-0 right-0 z-[60] transition-transform duration-300 ease-out ${isResultsOpen ? 'translate-y-0' : 'translate-y-full'}`}
        style={{
          pointerEvents: isResultsOpen ? 'auto' : 'none',
          top: `${drawerTopPx}px`,
          bottom: '12px'
        }}
      >
        <div
          className="mx-auto w-full max-w-3xl rounded-2xl border bg-background shadow-xl flex flex-col"
          style={{ height: `calc(100svh - ${drawerTopPx}px - 12px)` }}
        >
          <div className="p-3 border-b flex items-center justify-between shrink-0">
            <div className="text-sm font-medium">Results</div>
            <div className="text-xs text-muted-foreground">
              {isSearching ? 'Searching…' : `${results.length} rows`}
            </div>
          </div>
          <div className="p-3 overflow-auto flex-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Priority</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map(t => (
                  <TableRow key={t.id}>
                    <TableCell>{t.id}</TableCell>
                    <TableCell>{t.title}</TableCell>
                    <TableCell>{t.status}</TableCell>
                    <TableCell className="text-right">{t.priority}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  );
}
