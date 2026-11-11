import initSqlJs, { type Database } from 'sql.js';
import {
  applyClientSideQuery,
  buildDeleteSql,
  buildFindSql,
  buildInsertSql,
  buildSelectAllSql,
  buildSelectSql,
  buildUpdateSql,
  parsePredicate
} from '@romatech/orm';
import type { IDbProvider, QueryExpression, QueryObject, SqlDialect, TableColumnInfo } from '@romatech/orm';
import * as fs from 'fs';
import * as path from 'path';

type SqlJsDatabase = Database;

/**
 * Configuration options for the SQLite provider.
 */
export interface SqliteProviderOptions {
  /** Path to the database file. Use ':memory:' for in-memory database. Default: ':memory:' */
  filename?: string;
}

/**
 * SQL dialect for SQLite: identifiers are double-quoted (embedded quotes are
 * doubled) and parameters use positional `?` placeholders.
 */
const dialect: SqlDialect = {
  quoteIdentifier: identifier => `"${identifier.replace(/"/g, '""')}"`,
  parameter: () => '?'
};

/** Name of the savepoint used to make each `saveChanges()` batch atomic. */
const SAVEPOINT = 'roma_save_changes';

/**
 * SQLite provider for RomaTech ORM using sql.js (no native deps).
 * Works everywhere — Node.js, browsers, serverless.
 *
 * sql.js keeps the database in memory; when a file name is configured the
 * database is written back to disk after each successful `saveChanges()`,
 * after each committed transaction and on `disconnect()`.
 *
 * @example
 * ```ts
 * import { SqliteProvider } from '@romatech/orm-providers-sqlite';
 *
 * class AppDbContext extends DbContext {
 *     users = this.set(User);
 *     constructor() {
 *         super(new DbContextOptions().useProvider(
 *             new SqliteProvider({ filename: './mydb.sqlite' })
 *         ));
 *     }
 * }
 * ```
 */
export class SqliteProvider implements IDbProvider {
  private _db: SqlJsDatabase | null = null;
  private readonly _options: SqliteProviderOptions;
  /** File actually opened by `connect()` (constructor option or connection string). */
  private _filename = ':memory:';
  private readonly _pendingOps: string[] = [];
  private readonly _pendingParams: any[][] = [];
  private readonly _migrationTable = '__roma_migrations';

  constructor(optionsOrPath?: SqliteProviderOptions | string) {
    if (typeof optionsOrPath === 'string') {
      this._options = { filename: optionsOrPath };
    } else {
      this._options = optionsOrPath ?? { filename: ':memory:' };
    }
  }

  // ─── Connection ──────────────────────────────────────────────────────────────

  async connect(connectionString = ''): Promise<void> {
    const SQL = await initSqlJs();
    const filename = connectionString || this._options.filename || ':memory:';

    if (filename !== ':memory:' && fs.existsSync(filename)) {
      const buffer = fs.readFileSync(filename);
      this._db = new SQL.Database(buffer);
    } else {
      this._db = new SQL.Database();
    }

    this._filename = filename;
    this.exec('PRAGMA foreign_keys = ON');
    this.ensureMigrationTable();
  }

  async disconnect(): Promise<void> {
    if (this._db) {
      // Never write an uncommitted transaction to disk: closing discards it.
      this.persistIfNoTransaction();
      this._db.close();
      this._db = null;
    }
  }

  private get db(): SqlJsDatabase {
    if (!this._db) throw new Error('Not connected');
    return this._db;
  }

  private exec(sql: string, params?: any[]): void {
    if (params?.length) {
      this.db.run(sql, params.map(toSqliteValue));
    } else {
      this.db.exec(sql);
    }
  }

  private query(sql: string, params?: any[]): any[] {
    const stmt = this.db.prepare(sql);
    try {
      if (params?.length) stmt.bind(params.map(toSqliteValue));
      const results: any[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  /**
   * Writes the database to its file. The file is replaced atomically
   * (write to a temporary file, then rename) so a crash cannot leave a
   * truncated database behind.
   */
  private persist(): void {
    const filename = this._filename;
    if (filename && filename !== ':memory:') {
      const data = this.db.export();
      // export() reopens the database, which resets connection pragmas.
      this.db.exec('PRAGMA foreign_keys = ON');
      const dir = path.dirname(filename);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tempFile = `${filename}.${process.pid}.tmp`;
      fs.writeFileSync(tempFile, Buffer.from(data));
      fs.renameSync(tempFile, filename);
    }
  }

  /**
   * True when a transaction is open on the connection (opened with raw
   * `BEGIN`, e.g. by `DbContext.beginTransaction()`, or a raw `SAVEPOINT`).
   * SQLite rejects `BEGIN` inside a transaction, which is used as the probe.
   */
  private inTransaction(): boolean {
    try {
      this.db.exec('BEGIN');
    } catch {
      return true;
    }
    this.db.exec('ROLLBACK');
    return false;
  }

  /**
   * Writes the database file unless a transaction is open: `export()` closes
   * and reopens the sql.js database, which would discard (and, if written,
   * leak) uncommitted work. The pending work reaches the file on COMMIT.
   */
  private persistIfNoTransaction(): void {
    if (this._filename !== ':memory:' && !this.inTransaction()) {
      this.persist();
    }
  }

  /**
   * Runs a SELECT against one table and converts the values SQLite cannot
   * represent natively back to JavaScript, based on the declared column type:
   * `BOOL*` columns (stored as 0/1) become booleans and `DATE`/`TIME*`
   * columns (stored as ISO-8601 text) become `Date`. Without this, predicates
   * re-evaluated in memory (`active === true`, `born > date`) would silently
   * drop rows.
   */
  private queryTable(tableName: string, sql: string, params?: any[]): any[] {
    const rows = this.query(sql, params);
    if (rows.length === 0) return rows;
    const converters: Array<[string, (value: unknown) => unknown]> = [];
    for (const column of this.query('SELECT name, type FROM pragma_table_info(?)', [tableName])) {
      const type = String(column.type || '').toUpperCase();
      if (type.includes('BOOL')) converters.push([column.name, fromSqliteBoolean]);
      else if (type.includes('DATE') || type.includes('TIME')) converters.push([column.name, fromSqliteDate]);
    }
    if (converters.length === 0) return rows;
    for (const row of rows) {
      for (const [name, convert] of converters) {
        if (name in row) row[name] = convert(row[name]);
      }
    }
    return rows;
  }

  private ensureMigrationTable(): void {
    this.exec(`CREATE TABLE IF NOT EXISTS ${dialect.quoteIdentifier(this._migrationTable)} (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  }

  private enqueue(sql: string, params: unknown[]): void {
    this._pendingOps.push(sql);
    this._pendingParams.push(params as any[]);
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  async add<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildInsertSql(tableName, entity, dialect);
    this.enqueue(command.sql, command.params);
  }

  async addRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const e of entities) await this.add(e, tableName);
  }

  async update<T extends object>(entity: T, tableName: string): Promise<void> {
    const primaryKey = this.getPrimaryKeyColumn(tableName);
    // Nothing to SET besides the primary key: skip instead of emitting invalid SQL.
    if (!Object.entries(entity).some(([key, value]) => key !== primaryKey && value !== undefined)) {
      return;
    }
    const command = buildUpdateSql(tableName, entity, primaryKey, dialect);
    this.enqueue(command.sql, command.params);
  }

  async remove<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildDeleteSql(tableName, entity, this.getPrimaryKeyColumn(tableName), dialect);
    this.enqueue(command.sql, command.params);
  }

  async removeRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const e of entities) await this.remove(e, tableName);
  }

  async find<T extends object>(entity: T, tableName: string): Promise<T | undefined> {
    const command = buildFindSql(tableName, entity, this.getPrimaryKeyColumn(tableName), dialect);
    const rows = this.queryTable(tableName, command.sql, command.params);
    return rows[0] as T | undefined;
  }

  async getAll<T>(tableName: string): Promise<T[]> {
    return this.queryTable(tableName, buildSelectAllSql(tableName, dialect)) as T[];
  }

  // ─── Unit of Work ────────────────────────────────────────────────────────────

  /**
   * Runs every queued write atomically. A savepoint is used instead of
   * `BEGIN` so the batch also works inside a transaction opened with
   * `DbContext.beginTransaction()`. On failure the batch is rolled back, the
   * queue is cleared and the error is rethrown.
   */
  async saveChanges(): Promise<void> {
    const ops = this._pendingOps.splice(0);
    const params = this._pendingParams.splice(0);
    if (ops.length === 0) {
      return;
    }

    this.exec(`SAVEPOINT ${SAVEPOINT}`);
    try {
      for (let i = 0; i < ops.length; i++) {
        this.exec(ops[i], params[i]);
      }
    } catch (error) {
      this.exec(`ROLLBACK TO ${SAVEPOINT}`);
      this.exec(`RELEASE ${SAVEPOINT}`);
      throw error;
    }
    this.exec(`RELEASE ${SAVEPOINT}`);

    this.persistIfNoTransaction();
  }

  // ─── Query ───────────────────────────────────────────────────────────────────

  async executeQuery<T = any>(query: string, params?: any[]): Promise<T[]>;
  async executeQuery<T, TResult = T>(entityName: string, query: QueryObject<T, TResult>): Promise<TResult[]>;
  async executeQuery<T, TResult = T>(
    sqlOrEntity: string,
    paramsOrQuery?: any[] | QueryObject<T, TResult>
  ): Promise<T[] | TResult[]> {
    if (Array.isArray(paramsOrQuery) || paramsOrQuery === undefined) {
      // Raw SQL returns the values exactly as SQLite stores them (no type
      // conversion: the result is not tied to one table).
      const rows = this.query(sqlOrEntity, paramsOrQuery) as T[];
      // Raw writes, DDL and COMMIT (how `DbContext.beginTransaction()` and
      // `Transaction.commit()` drive this provider) reach the file at once;
      // nothing is written while a transaction is open.
      if (!/^\s*(SELECT|EXPLAIN)\b/i.test(sqlOrEntity)) {
        this.persistIfNoTransaction();
      }
      return rows;
    }

    // QueryObject path: push WHERE / ORDER BY to SQLite, then let the core
    // apply the parts that could not be translated (and skip/take/select)
    // over rows converted back to booleans and dates.
    const command = buildSelectSql(sqlOrEntity, serverWhereQuery(paramsOrQuery), dialect);
    const rows = this.queryTable(sqlOrEntity, command.sql, command.params) as T[];
    return applyClientSideQuery(rows, paramsOrQuery);
  }

  // ─── Migrations ──────────────────────────────────────────────────────────────

  async addMigration(name: string): Promise<void> {
    this.exec(`INSERT INTO ${dialect.quoteIdentifier(this._migrationTable)} (name) VALUES (?)`, [name]);
    this.persistIfNoTransaction();
  }
  async removeMigration(name: string): Promise<void> {
    this.exec(`DELETE FROM ${dialect.quoteIdentifier(this._migrationTable)} WHERE name=?`, [name]);
    this.persistIfNoTransaction();
  }
  async applyMigrations(): Promise<void> {}
  async getMigrations(): Promise<string[]> { return this.getMigrationHistory(); }
  async getMigrationHistory(): Promise<string[]> { return this.query(`SELECT name FROM ${dialect.quoteIdentifier(this._migrationTable)} ORDER BY applied_at, name`).map(r => r.name); }
  async updateDatabase(): Promise<void> {}
  async downgradeDatabase(): Promise<void> {}

  // ─── Schema ──────────────────────────────────────────────────────────────────

  /**
   * Creates a table. Every column flagged `primaryKey` is part of the primary
   * key (composite keys are supported); `input.primaryKey` may name the key
   * when no column is flagged, or repeat one of the flagged columns (as
   * `MigrationService` does), and any other combination is rejected.
   */
  async createTable(input: { tableName: string; columns: TableColumnInfo[]; primaryKey?: string }): Promise<void> {
    const keys = resolvePrimaryKey(input);
    const cols = input.columns
      .map(c => `${dialect.quoteIdentifier(c.name)} ${this.mapType(c.tsType)}${keys.includes(c.name) ? ' NOT NULL' : ''}`)
      .join(', ');
    const primaryKeySql = keys.length ? `, PRIMARY KEY (${keys.map(key => dialect.quoteIdentifier(key)).join(', ')})` : '';
    this.exec(`CREATE TABLE IF NOT EXISTS ${dialect.quoteIdentifier(input.tableName)} (${cols}${primaryKeySql})`);
    this.persistIfNoTransaction();
  }

  async dropTable(tableName: string): Promise<void> {
    this.exec(`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(tableName)}`);
    this.persistIfNoTransaction();
  }
  async addColumn(tableName: string, col: TableColumnInfo): Promise<void> {
    this.exec(`ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD COLUMN ${dialect.quoteIdentifier(col.name)} ${this.mapType(col.tsType)}`);
    this.persistIfNoTransaction();
  }
  async removeColumn(tableName: string, colName: string): Promise<void> {
    this.exec(`ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(colName)}`);
    this.persistIfNoTransaction();
  }

  // ─── Scaffold ────────────────────────────────────────────────────────────────

  async scaffold(): Promise<void> {}
  async getTables(): Promise<string[]> { return this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!=?`, [this._migrationTable]).map(r => r.name); }
  async getColumnsForTable(table: string): Promise<TableColumnInfo[]> {
    // `pk` is the 1-based position inside the primary key (0 = not part of it).
    return this.query('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid', [table])
      .map(r => ({ name: r.name, primaryKey: r.pk > 0, tsType: this.inferType(r.type) }));
  }

  /**
   * Resolves the single primary-key column of a table (falls back to `id`
   * when the table has none). Composite keys are rejected: matching rows by
   * only one of their key columns would update or delete several rows.
   */
  private getPrimaryKeyColumn(tableName: string): string {
    const keys = this.query('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', [tableName]).map(r => r.name as string);
    if (keys.length > 1) {
      throw new Error(`Table '${tableName}' has a composite primary key (${keys.join(', ')}); update/remove/find by entity support a single-column key only.`);
    }
    return keys[0] || 'id';
  }

  /**
   * Declared column types. `BOOLEAN` and `DATETIME` have NUMERIC affinity
   * (booleans are stored as 0/1, ISO-8601 text stays text) and tell the read
   * path to convert the values back (see `queryTable`).
   */
  private mapType(ts: string): string {
    switch ((ts || '').toLowerCase()) {
      case 'number': return 'REAL';
      case 'boolean': return 'BOOLEAN';
      case 'date': return 'DATETIME';
      default: return 'TEXT';
    }
  }

  private inferType(sql: string): string {
    const u = (sql || '').toUpperCase();
    if (u.includes('BOOL')) return 'boolean';
    if (u.includes('DATE') || u.includes('TIME')) return 'Date';
    if (['INT', 'REAL', 'FLOA', 'DOUB', 'NUM', 'DEC'].some(token => u.includes(token))) return 'number';
    return 'string';
  }
}

/**
 * Whether the installed `@romatech/orm` parses predicates into SQL that can
 * drop rows JavaScript keeps. 2.0.x turns bare members into `= true/false`
 * (`!u.deletedAt` becomes `"deletedAt" = 0`, dropping every NULL row),
 * `!==` into `!=` (drops NULL rows), `!s.includes(x)` into a case-insensitive
 * `NOT LIKE`, and `<`/`<=` into comparisons that drop NULL rows (`null < 10` is
 * true in JavaScript). Later versions leave those predicates unparsed, so the
 * probe (`!x.flag` parsed or not) tells the two apart without a version check.
 */
const LEGACY_WHERE_PARSER = ((): boolean => {
  try {
    return typeof parsePredicate !== 'function' || parsePredicate((x: any) => !x.flag) !== undefined;
  } catch {
    return true;
  }
})();

/**
 * With a legacy core, keeps in the SQL `WHERE` only the parsed conditions that
 * match at least every row the JavaScript predicate accepts (an `&&` keeps its
 * safe conjuncts, an `||` is kept only when every branch is safe). The rest is
 * evaluated in memory by `applyClientSideQuery`, which always re-applies the
 * original predicates. With a newer core the query is used as given.
 */
function serverWhereQuery<T, TResult>(query: QueryObject<T, TResult>): QueryObject<T, TResult> {
  const predicates = query.predicates ?? [];
  const expressions = query.whereExpressions ?? [];
  if (!LEGACY_WHERE_PARSER || predicates.length === 0 || predicates.length !== expressions.length) {
    return query;
  }
  const safe = expressions
    .map(sqlSafeExpression)
    .filter((expression): expression is QueryExpression => expression !== null);
  // The core pushes a WHERE only when there is one parsed expression per predicate.
  return { ...query, predicates: safe.map(() => () => true), whereExpressions: safe };
}

function sqlSafeExpression(expression: QueryExpression): QueryExpression | null {
  if (expression.kind === 'logical') {
    const parts = expression.expressions.map(sqlSafeExpression);
    if (expression.operator === 'or') {
      return parts.every(part => part !== null) ? expression : null;
    }
    const known = parts.filter((part): part is QueryExpression => part !== null);
    if (known.length === 0) return null;
    return known.length === 1 ? known[0] : { ...expression, expressions: known };
  }

  const value: any = expression.value;
  switch (expression.operator) {
    case '=':
      // `= true/false` may stand for a bare member (truthy/falsy in JavaScript).
      return typeof value === 'boolean' ? null : expression;
    case '!=':
      // Only `IS NOT NULL` is exact; `col != v` drops the NULL rows.
      return value === null || value === undefined ? expression : null;
    case '>': return (null as any) > value ? null : expression;
    case '>=': return (null as any) >= value ? null : expression;
    case '<': return (null as any) < value ? null : expression;
    case '<=': return (null as any) <= value ? null : expression;
    case 'like':
      // SQLite's LIKE is case-insensitive: a superset of the JavaScript match.
      return expression;
    default:
      return null;
  }
}

/** Resolves the primary-key columns for `createTable` (see its docs). */
function resolvePrimaryKey(input: { tableName: string; columns: TableColumnInfo[]; primaryKey?: string }): string[] {
  const flagged = input.columns.filter(column => column.primaryKey).map(column => column.name);
  const explicit = input.primaryKey;
  if (!explicit) return flagged;
  if (!input.columns.some(column => column.name === explicit)) {
    throw new Error(`createTable('${input.tableName}'): primary key column '${explicit}' is not one of the table columns.`);
  }
  if (flagged.length === 0) return [explicit];
  if (!flagged.includes(explicit)) {
    throw new Error(
      `createTable('${input.tableName}'): primaryKey '${explicit}' conflicts with the columns flagged as primary key (${flagged.join(', ')}).`
    );
  }
  return flagged;
}

/** 0/1 to boolean; anything else (NULL, unexpected values) is returned as stored. */
function fromSqliteBoolean(value: unknown): unknown {
  if (value === 1) return true;
  if (value === 0) return false;
  return value;
}

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * ISO-8601 text to Date. Text without a time zone (SQLite's own
 * `datetime('now')` format, `YYYY-MM-DD HH:MM:SS`) is UTC, as in SQLite's
 * date functions. Numbers and text in any other format are returned as stored.
 */
function fromSqliteDate(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = ISO_DATE.exec(value);
  if (!match) return value;
  const [, day, time, zone] = match;
  const date = new Date(time ? `${day}T${time}${zone ?? 'Z'}` : `${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date;
}

/**
 * Converts a JavaScript value into something sql.js can bind: dates become
 * ISO-8601 text and `undefined` becomes NULL (sql.js throws on both).
 */
function toSqliteValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}
