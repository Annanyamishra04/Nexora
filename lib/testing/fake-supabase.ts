/**
 * A small in-memory stand-in for the request-scoped Supabase client, used
 * only by route-level tests. It emulates the parts of Postgres/RLS this
 * app actually relies on — behaviour that was verified against a real
 * PostgreSQL 16 instance running migrations 0001–0004 + 0007:
 *
 *  - every table is filtered to rows whose user_id = the session user
 *    (cross-user reads/updates/deletes match ZERO rows rather than erroring);
 *  - `messages` has NO update policy (updates match zero rows);
 *  - inserting a message/link requires the parent conversation to be the
 *    caller's own, and user_id to equal the caller;
 *  - deleting a conversation cascades to its messages and
 *    conversation_documents, but never to documents.
 *
 * It is NOT a general Supabase mock — only the builder methods the app
 * uses exist. Failures can be injected per (table, operation) to exercise
 * rollback paths.
 */

type Row = Record<string, any>;
type Op = "select" | "insert" | "update" | "delete" | "upsert";

export interface InjectedFailure {
  table: string;
  op: Op;
  /** How many matching calls should fail (default 1). */
  times?: number;
  /** Optional predicate over the call, e.g. only fail deletes that carry a `gte` filter. */
  when?: (call: { filters: string[]; values?: Row }) => boolean;
  message?: string;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  userId: string | null;
  failures: InjectedFailure[];
  /** Every operation executed, in order — for asserting what a route did (and didn't) touch. */
  log: { table: string; op: Op; filters: string[] }[];
  rpcHandlers: Record<string, (args: any, ctx: { userId: string | null }) => { data: any; error: any }>;
}

const TABLES_WITH_OWNER = ["conversations", "messages", "conversation_documents", "documents", "document_chunks"];

let clock = Date.parse("2026-01-01T00:00:00.000Z");
/** Monotonic timestamp source shared by the fake's inserts AND test seeding, so ordering is always consistent. */
export function nextTimestamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

let idCounter = 0;
export function fakeUuid(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, "0")}`;
}

export function createFakeSupabase(options: { userId: string | null; tables?: Partial<Record<string, Row[]>> }) {
  const db: FakeDb = {
    userId: options.userId,
    tables: {
      conversations: [],
      messages: [],
      conversation_documents: [],
      documents: [],
      document_chunks: [],
      ...(options.tables as Record<string, Row[]>),
    },
    failures: [],
    log: [],
    rpcHandlers: {
      // Rate limiting (Phase 6) defaults to "allowed" so existing route
      // tests that don't care about it aren't forced to mock it — tests
      // that DO want to exercise the 429 path override this handler.
      check_rate_limit: () => ({
        data: [{ allowed: true, current_count: 1, retry_after_seconds: 0 }],
        error: null,
      }),
    },
  };

  const owns = (table: string, row: Row) =>
    !TABLES_WITH_OWNER.includes(table) || (db.userId !== null && row.user_id === db.userId);

  function takeFailure(table: string, op: Op, call: { filters: string[]; values?: Row }): string | null {
    for (const failure of db.failures) {
      if (failure.table !== table || failure.op !== op) continue;
      if ((failure.times ?? 1) <= 0) continue;
      if (failure.when && !failure.when(call)) continue;
      failure.times = (failure.times ?? 1) - 1;
      return failure.message ?? "injected failure";
    }
    return null;
  }

  class Query implements PromiseLike<{ data: any; error: any }> {
    private op: Op = "select";
    private filters: ((row: Row) => boolean)[] = [];
    private filterLabels: string[] = [];
    private orderBy: { column: string; ascending: boolean } | null = null;
    private limitCount: number | null = null;
    private values: Row | null = null;
    private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    private returning = false;
    private columns: string[] | null = null;
    private mode: "many" | "single" | "maybeSingle" = "many";

    constructor(private table: string) {}

    select(columns?: string) {
      if (this.op === "select") this.returning = true;
      else this.returning = true;
      this.columns = columns && columns !== "*" ? columns.split(",").map((c) => c.trim()) : null;
      return this;
    }
    insert(values: Row) {
      this.op = "insert";
      this.values = values;
      return this;
    }
    upsert(values: Row, options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
      this.op = "upsert";
      this.values = values;
      this.upsertOptions = options;
      return this;
    }
    update(values: Row) {
      this.op = "update";
      this.values = values;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    private addFilter(label: string, fn: (row: Row) => boolean) {
      this.filterLabels.push(label);
      this.filters.push(fn);
      return this;
    }
    eq(column: string, value: unknown) {
      return this.addFilter("eq", (r) => r[column] === value);
    }
    neq(column: string, value: unknown) {
      return this.addFilter("neq", (r) => r[column] !== value);
    }
    gt(column: string, value: any) {
      return this.addFilter("gt", (r) => r[column] > value);
    }
    gte(column: string, value: any) {
      return this.addFilter("gte", (r) => r[column] >= value);
    }
    in(column: string, values: unknown[]) {
      return this.addFilter("in", (r) => values.includes(r[column]));
    }
    order(column: string, opts: { ascending?: boolean } = {}) {
      this.orderBy = { column, ascending: opts.ascending !== false };
      return this;
    }
    limit(count: number) {
      this.limitCount = count;
      return this;
    }
    single() {
      this.mode = "single";
      return this;
    }
    maybeSingle() {
      this.mode = "maybeSingle";
      return this;
    }

    private project(row: Row): Row {
      if (!this.columns) return { ...row };
      const out: Row = {};
      for (const c of this.columns) out[c] = row[c];
      return out;
    }

    private shape(rows: Row[]) {
      const projected = rows.map((r) => this.project(r));
      if (this.mode === "single") {
        return projected.length === 1
          ? { data: projected[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      }
      if (this.mode === "maybeSingle") {
        if (projected.length > 1) return { data: null, error: { message: "multiple rows" } };
        return { data: projected[0] ?? null, error: null };
      }
      return { data: projected, error: null };
    }

    private matching(): Row[] {
      return (db.tables[this.table] ?? []).filter((row) => owns(this.table, row) && this.filters.every((f) => f(row)));
    }

    private execute(): { data: any; error: any } {
      const call = { filters: this.filterLabels, values: this.values ?? undefined };
      db.log.push({ table: this.table, op: this.op, filters: this.filterLabels });

      const failure = takeFailure(this.table, this.op, call);
      if (failure) return { data: null, error: { message: failure } };

      const rows = (db.tables[this.table] ??= []);

      switch (this.op) {
        case "select": {
          let result = this.matching();
          if (this.orderBy) {
            const { column, ascending } = this.orderBy;
            result = [...result].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0));
            if (!ascending) result.reverse();
          }
          if (this.limitCount !== null) result = result.slice(0, this.limitCount);
          return this.shape(result);
        }

        case "insert":
        case "upsert": {
          const values = this.values!;

          if (this.op === "upsert" && this.upsertOptions.onConflict) {
            const keys = this.upsertOptions.onConflict.split(",").map((k) => k.trim());
            const existing = rows.find((r) => keys.every((k) => r[k] === values[k]));
            if (existing) {
              if (this.upsertOptions.ignoreDuplicates) return { data: null, error: null };
              Object.assign(existing, values);
              return this.returning ? this.shape([existing]) : { data: null, error: null };
            }
          }

          // RLS insert checks (see migrations 0002 / 0004).
          if (TABLES_WITH_OWNER.includes(this.table) && values.user_id !== db.userId) {
            return { data: null, error: { message: `new row violates row-level security policy for table "${this.table}"` } };
          }
          if (this.table === "messages" || this.table === "conversation_documents") {
            const conversation = db.tables.conversations!.find((c) => c.id === values.conversation_id);
            if (!conversation || conversation.user_id !== db.userId) {
              return { data: null, error: { message: `new row violates row-level security policy for table "${this.table}"` } };
            }
          }

          const row: Row = { id: fakeUuid(), created_at: nextTimestamp(), ...values };
          if (this.table === "messages") {
            row.status ??= "complete";
            row.metadata ??= null;
          }
          if (this.table === "conversations") {
            row.title ??= "New conversation";
            row.updated_at ??= row.created_at;
          }
          rows.push(row);
          return this.returning ? this.shape([row]) : { data: null, error: null };
        }

        case "update": {
          // messages has no UPDATE policy => nothing is ever updatable.
          const targets = this.table === "messages" ? [] : this.matching();
          for (const row of targets) {
            Object.assign(row, this.values);
            if ("updated_at" in row) row.updated_at = nextTimestamp();
          }
          return this.returning ? this.shape(targets) : { data: null, error: null };
        }

        case "delete": {
          const targets = this.matching();
          const targetSet = new Set(targets);
          db.tables[this.table] = rows.filter((r) => !targetSet.has(r));
          if (this.table === "conversations") {
            const ids = new Set(targets.map((t) => t.id));
            db.tables.messages = db.tables.messages!.filter((m) => !ids.has(m.conversation_id));
            db.tables.conversation_documents = db.tables.conversation_documents!.filter((l) => !ids.has(l.conversation_id));
          }
          return this.returning ? this.shape(targets) : { data: null, error: null };
        }
      }
    }

    then<T1 = { data: any; error: any }, T2 = never>(
      onfulfilled?: ((value: { data: any; error: any }) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
    ): PromiseLike<T1 | T2> {
      return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
    }
  }

  const client = {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: any) => {
      const handler = db.rpcHandlers[name];
      if (!handler) return { data: null, error: { message: `rpc ${name} not mocked` } };
      return handler(args, { userId: db.userId });
    },
    auth: {
      getUser: async () => ({
        data: { user: db.userId ? { id: db.userId, email: "test@example.com" } : null },
        error: null,
      }),
    },
  };

  return { client, db };
}

/** Reads an NDJSON chat response body into parsed events. */
export async function readEvents(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
