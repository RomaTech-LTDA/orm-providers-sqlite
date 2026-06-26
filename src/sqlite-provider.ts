import initSqlJs, { type Database } from 'sql.js';
import type { IDbProvider, TableColumnInfo } from '@romatech/orm';
import type { QueryObject } from '@romatech/orm';
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
 * SQLite provider for RomaTech ORM using sql.js (no native deps).
 * Works everywhere — Node.js, browsers, serverless.
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

  async connect(_connectionString: string): Promise<void> {
    const SQL = await initSqlJs();
    const filename = _connectionString || this._options.filename || ':memory:';

    if (filename !== ':memory:' && fs.existsSync(filename)) {
      const buffer = fs.readFileSync(filename);
      this._db = new SQL.Database(buffer);
    } else {
      this._db = new SQL.Database();
    }

    this.exec('PRAGMA journal_mode = WAL');
    this.exec('PRAGMA foreign_keys = ON');
    this.ensureMigrationTable();
  }

  async disconnect(): Promise<void> {
    if (this._db) {
      this.persist();
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
      this.db.run(sql, params);
    } else {
      this.db.exec(sql);
    }
  }

  private query(sql: string, params?: any[]): any[] {
    const stmt = this.db.prepare(sql);
    if (params?.length) stmt.bind(params);
    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  private persist(): void {
    const filename = this._options.filename;
    if (filename && filename !== ':memory:') {
      const data = this.db.export();
      const dir = path.dirname(filename);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filename, Buffer.from(data));
    }
  }

  private ensureMigrationTable(): void {
    this.exec(`CREATE TABLE IF NOT EXISTS "${this._migrationTable}" (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  async add<T extends object>(entity: T, tableName: string): Promise<void> {
    const cols = Object.keys(entity);
    const sql = `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    this._pendingOps.push(sql);
    this._pendingParams.push(Object.values(entity));
  }

  async addRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const e of entities) await this.add(e, tableName);
  }

  async update<T extends object>(entity: T, tableName: string): Promise<void> {
    const entries = Object.entries(entity);
    const id = (entity as any).id;
    const sets = entries.filter(([k]) => k !== 'id').map(([k]) => `"${k}"=?`).join(',');
    const values = entries.filter(([k]) => k !== 'id').map(([,v]) => v);
    this._pendingOps.push(`UPDATE "${tableName}" SET ${sets} WHERE "id"=?`);
    this._pendingParams.push([...values, id]);
  }

  async remove<T extends object>(entity: T, tableName: string): Promise<void> {
    this._pendingOps.push(`DELETE FROM "${tableName}" WHERE "id"=?`);
    this._pendingParams.push([(entity as any).id]);
  }

  async removeRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const e of entities) await this.remove(e, tableName);
  }

  async find<T extends object>(entity: T, tableName: string): Promise<T | undefined> {
    const rows = this.query(`SELECT * FROM "${tableName}" WHERE "id"=?`, [(entity as any).id]);
    return rows[0] as T | undefined;
  }

  async getAll<T>(tableName: string): Promise<T[]> {
    return this.query(`SELECT * FROM "${tableName}"`) as T[];
  }

  // ─── Unit of Work ────────────────────────────────────────────────────────────

  async saveChanges(): Promise<void> {
    this.exec('BEGIN');
    for (let i = 0; i < this._pendingOps.length; i++) {
      this.exec(this._pendingOps[i], this._pendingParams[i]);
    }
    this.exec('COMMIT');
    this._pendingOps.length = 0;
    this._pendingParams.length = 0;
    this.persist();
  }

  // ─── Query ───────────────────────────────────────────────────────────────────

  async executeQuery<T = any>(sqlOrEntity: string, paramsOrQuery?: any[] | QueryObject<any, any>): Promise<T[]> {
    if (Array.isArray(paramsOrQuery) || paramsOrQuery === undefined) {
      return this.query(sqlOrEntity, paramsOrQuery as any[]) as T[];
    }
    return this.query(`SELECT * FROM "${sqlOrEntity}"`) as T[];
  }

  // ─── Migrations ──────────────────────────────────────────────────────────────

  async addMigration(name: string): Promise<void> { this.exec(`INSERT INTO "${this._migrationTable}" (name) VALUES (?)`, [name]); }
  async removeMigration(name: string): Promise<void> { this.exec(`DELETE FROM "${this._migrationTable}" WHERE name=?`, [name]); }
  async applyMigrations(): Promise<void> {}
  async getMigrations(): Promise<string[]> { return this.getMigrationHistory(); }
  async getMigrationHistory(): Promise<string[]> { return this.query(`SELECT name FROM "${this._migrationTable}" ORDER BY applied_at`).map(r => r.name); }
  async updateDatabase(): Promise<void> {}
  async downgradeDatabase(): Promise<void> {}

  // ─── Schema ──────────────────────────────────────────────────────────────────

  async createTable(input: { tableName: string; columns: TableColumnInfo[] }): Promise<void> {
    const cols = input.columns.map(c => `"${c.name}" ${this.mapType(c.tsType)}${c.primaryKey ? ' PRIMARY KEY' : ''}`).join(', ');
    this.exec(`CREATE TABLE IF NOT EXISTS "${input.tableName}" (${cols})`);
  }

  async dropTable(tableName: string): Promise<void> { this.exec(`DROP TABLE IF EXISTS "${tableName}"`); }
  async addColumn(tableName: string, col: TableColumnInfo): Promise<void> { this.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${this.mapType(col.tsType)}`); }
  async removeColumn(tableName: string, colName: string): Promise<void> { this.exec(`ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`); }

  // ─── Scaffold ────────────────────────────────────────────────────────────────

  async scaffold(): Promise<void> {}
  async getTables(): Promise<string[]> { return this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!=?`, [this._migrationTable]).map(r => r.name); }
  async getColumnsForTable(table: string): Promise<TableColumnInfo[]> {
    return this.query(`PRAGMA table_info("${table}")`).map(r => ({ name: r.name, primaryKey: r.pk === 1, tsType: this.inferType(r.type) }));
  }

  private mapType(ts: string): string { return ts === 'number' ? 'REAL' : ts === 'boolean' ? 'INTEGER' : 'TEXT'; }
  private inferType(sql: string): string { const u = (sql||'').toUpperCase(); return u.includes('INT') || u.includes('REAL') ? 'number' : u.includes('BOOL') ? 'boolean' : 'string'; }
}
