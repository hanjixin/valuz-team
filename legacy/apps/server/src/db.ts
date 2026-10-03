/** The one database entry point — every query goes through `Db`. */
import pg from "pg";

// bigint columns (event seq, token counts, epoch ms) all fit in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(text: string, params?: unknown[]): Promise<T | null>;
}

const wrap = (runner: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Queryable => ({
  async query<T extends Row>(text: string, params?: unknown[]): Promise<T[]> {
    return (await runner.query(text, params)).rows as T[];
  },
  async one<T extends Row>(text: string, params?: unknown[]): Promise<T | null> {
    return ((await runner.query(text, params)).rows[0] as T | undefined) ?? null;
  },
});

export class Db implements Queryable {
  readonly pool: pg.Pool;
  private readonly q: Queryable;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 20 });
    this.q = wrap(this.pool);
  }

  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]> {
    return this.q.query<T>(text, params);
  }

  one<T extends Row = Row>(text: string, params?: unknown[]): Promise<T | null> {
    return this.q.one<T>(text, params);
  }

  async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(wrap(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

/** pg sends a JS array as a Postgres array; jsonb columns need explicit JSON. */
export const json = (value: unknown): string | null => (value == null ? null : JSON.stringify(value));
