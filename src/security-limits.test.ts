import { IAdapter, IQueryExecutionOptions } from './adapters';
import { QueryExpression } from './parser/types';
import { createQueryKit } from './index';
import { QuerySecurityError } from './security';

interface ITaskSchema {
  tasks: {
    status: string;
    priority: number;
  };
}

interface IRecordedExecution {
  limit: unknown;
  offset: unknown;
}

/**
 * Adapter that records execution options and can delay completion.
 */
class RecordingAdapter implements IAdapter {
  public executions: IRecordedExecution[] = [];
  public hangMs = 0;

  public initialize(): void {
    return undefined;
  }

  public canExecute(): boolean {
    return true;
  }

  public async execute<T = unknown>(
    _tableName: string,
    _expression: QueryExpression,
    options?: IQueryExecutionOptions
  ): Promise<T[]> {
    this.executions.push({
      limit: options?.limit,
      offset: options?.offset
    });
    if (this.hangMs > 0) {
      await new Promise<void>(resolve => {
        setTimeout(resolve, this.hangMs);
      });
    }
    return [];
  }
}

const taskSchema: ITaskSchema = {
  tasks: {
    status: 'open',
    priority: 1
  }
};

describe('createQueryKit security limits', () => {
  it('applies the default result limit when the caller does not set one', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema
    });
    await queryKit.query('tasks').where('status:open').execute();
    expect(adapter.executions).toEqual([{ limit: 100, offset: undefined }]);
  });

  it('uses a configured defaultLimit when the caller does not set one', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { defaultLimit: 25 }
    });
    await queryKit.query('tasks').where('status:open').execute();
    expect(adapter.executions[0]?.limit).toBe(25);
  });

  it('caps a caller limit that is above maxLimit', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { maxLimit: 50 }
    });
    await queryKit.query('tasks').where('status:open').limit(5000).execute();
    expect(adapter.executions[0]?.limit).toBe(50);
  });

  it('keeps a caller limit that is within maxLimit', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { maxLimit: 50 }
    });
    await queryKit.query('tasks').where('status:open').limit(10).execute();
    expect(adapter.executions[0]?.limit).toBe(10);
  });

  it('keeps an explicit zero limit instead of replacing it with the default', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { defaultLimit: 25 }
    });
    await queryKit.query('tasks').where('status:open').limit(0).execute();
    expect(adapter.executions[0]?.limit).toBe(0);
  });

  it('caps the default limit when it is configured above maxLimit', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { defaultLimit: 500, maxLimit: 40 }
    });
    await queryKit.query('tasks').where('status:open').execute();
    expect(adapter.executions[0]?.limit).toBe(40);
  });

  it('rejects a negative limit before the adapter runs', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema
    });
    await expect(
      queryKit.query('tasks').where('status:open').limit(-1).execute()
    ).rejects.toThrow(QuerySecurityError);
    expect(adapter.executions).toHaveLength(0);
  });

  it('rejects a non-finite limit before the adapter runs', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema
    });
    await expect(
      queryKit.query('tasks').where('status:open').limit(Number.NaN).execute()
    ).rejects.toThrow(QuerySecurityError);
    expect(adapter.executions).toHaveLength(0);
  });

  it('rejects execution that exceeds queryTimeout', async () => {
    const adapter = new RecordingAdapter();
    adapter.hangMs = 250;
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { queryTimeout: 20 }
    });
    await expect(
      queryKit.query('tasks').where('status:open').execute()
    ).rejects.toThrow(/timeout/i);
  });

  it('returns results when execution finishes inside queryTimeout', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { queryTimeout: 200 }
    });
    await expect(
      queryKit.query('tasks').where('status:open').execute()
    ).resolves.toEqual([]);
  });

  it('keeps the default timeout when queryTimeout is explicitly undefined', async () => {
    const adapter = new RecordingAdapter();
    adapter.hangMs = 15;
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { queryTimeout: undefined }
    });
    await expect(
      queryKit.query('tasks').where('status:open').execute()
    ).resolves.toEqual([]);
  });

  it('keeps the default limit when defaultLimit is explicitly undefined', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { defaultLimit: undefined }
    });
    await queryKit.query('tasks').where('status:open').execute();
    expect(adapter.executions[0]?.limit).toBe(100);
  });
});

describe('createQueryKit limit validation', () => {
  it('rejects a fractional caller limit before the adapter runs', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({ adapter, schema: taskSchema });
    await expect(
      queryKit.query('tasks').where('status:open').limit(2.5).execute()
    ).rejects.toThrow(QuerySecurityError);
    expect(adapter.executions).toHaveLength(0);
  });

  it('rejects a maxLimit that is not a non-negative integer when the kit is created', () => {
    for (const maxLimit of [Number.NaN, -1, 2.5, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createQueryKit({
          adapter: new RecordingAdapter(),
          schema: taskSchema,
          security: { maxLimit }
        })
      ).toThrow(QuerySecurityError);
    }
  });

  it('rejects a defaultLimit that is not a non-negative integer when the kit is created', () => {
    for (const defaultLimit of [Number.NaN, -1, 2.5]) {
      expect(() =>
        createQueryKit({
          adapter: new RecordingAdapter(),
          schema: taskSchema,
          security: { defaultLimit }
        })
      ).toThrow(QuerySecurityError);
    }
  });

  it('rejects a queryTimeout outside the setTimeout range when the kit is created', () => {
    for (const queryTimeout of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      2147483648
    ]) {
      expect(() =>
        createQueryKit({
          adapter: new RecordingAdapter(),
          schema: taskSchema,
          security: { queryTimeout }
        })
      ).toThrow(QuerySecurityError);
    }
  });

  it('accepts the largest delay setTimeout honours as queryTimeout', async () => {
    const adapter = new RecordingAdapter();
    adapter.hangMs = 15;
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { queryTimeout: 2147483647 }
    });
    await expect(
      queryKit.query('tasks').where('status:open').execute()
    ).resolves.toEqual([]);
  });

  it('still caps with a valid maxLimit', async () => {
    const adapter = new RecordingAdapter();
    const queryKit = createQueryKit({
      adapter,
      schema: taskSchema,
      security: { maxLimit: 3 }
    });
    await queryKit.query('tasks').where('status:open').limit(10).execute();
    expect(adapter.executions[0]?.limit).toBe(3);
  });
});
