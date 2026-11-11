# @romatech/orm-providers-sqlite

[![npm](https://img.shields.io/npm/v/%40romatech%2Form-providers-sqlite)](https://www.npmjs.com/package/@romatech/orm-providers-sqlite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/RomaTech-LTDA/orm-providers-sqlite/blob/main/LICENSE)

SQLite provider for [@romatech/orm](https://www.npmjs.com/package/@romatech/orm). Zero native dependencies (uses sql.js/WASM).

## Installation

```bash
npm install @romatech/orm @romatech/orm-providers-sqlite reflect-metadata
```

## Quick Start

```ts
import 'reflect-metadata';
import { DbContext, DbContextOptions } from '@romatech/orm';
import { SqliteProvider } from '@romatech/orm-providers-sqlite';

class AppDbContext extends DbContext {
    users = this.set(User);
    constructor() {
        super(new DbContextOptions().useProvider(
            new SqliteProvider({ filename: './mydb.sqlite' })
        ));
    }
}

// In-memory (great for tests)
new SqliteProvider(':memory:')
```

## Features

- Zero native dependencies (sql.js compiles SQLite to WASM)
- Runs on Node.js (file databases use `fs`)
- File-based or in-memory databases
- Each `saveChanges()` is atomic (one savepoint; a failure rolls the whole batch back)
- Transactions through `DbContext.beginTransaction()`
- Full CRUD, migrations, scaffold support

## Persistence and concurrency

sql.js keeps the whole database **in memory**. When a file is configured
(`new SqliteProvider({ filename })`, `new SqliteProvider('./app.sqlite')` or
`connect('./app.sqlite')`), the provider loads it on `connect()` and writes the
complete database back to that file:

- after each successful `saveChanges()`;
- after each DDL statement (`createTable`, `dropTable`, `addColumn`, `removeColumn`),
  each `addMigration`/`removeMigration` and each raw statement other than
  `SELECT`/`EXPLAIN` executed outside a transaction;
- on `COMMIT` of a transaction, and on `disconnect()`.

Nothing is written while a transaction is open; `disconnect()` with an open
transaction discards it. Each write replaces the file atomically (temporary
file + rename), so a crash leaves either the previous or the new version, and
the cost of a write grows with the size of the database.

**Single writer.** The file is not locked and other processes never see changes
until the next write, and then only if they reconnect. Two providers (or
processes) writing the same file overwrite each other's changes: use one
provider instance per file. For concurrent writers use a server database.

`:memory:` (the default) never touches the disk; its data is lost on
`disconnect()` or process exit.

## Type mapping

| Entity type | Column type created | Stored as | Read back as |
|-------------|---------------------|-----------|--------------|
| `number`    | `REAL`              | number    | `number` |
| `string`    | `TEXT`              | text      | `string` |
| `boolean`   | `BOOLEAN`           | `0` / `1` | `boolean` |
| `Date`      | `DATETIME`          | ISO-8601 text (UTC) | `Date` |

Reads through the entity API (`find`, `getAll`, queries built with `where`/`orderBy`/...)
convert values by the declared column type: columns whose type contains `BOOL` become
booleans, and columns whose type contains `DATE` or `TIME` become `Date` (ISO-8601 text;
text without a time zone, such as SQLite's `datetime('now')`, is read as UTC). This also
applies to tables you create yourself. Raw SQL (`rawQuery`/`executeQuery(sql, params)`)
returns values exactly as SQLite stores them.

## Query translation

`where`/`orderBy` predicates that `@romatech/orm` can parse become SQL `WHERE`/`ORDER BY`; everything
else (and `skip`/`take`/`select`) is applied in memory over the converted rows. Use `@romatech/orm`
2.1.0 or later: 2.0.x translates `x.name !== 'a'` and `!x.flag` to SQL that drops rows where the
column is `NULL`.

## Primary keys

`update`, `remove` and `find` use the table's primary key (falling back to `id` for tables
without one). `createTable` supports composite keys (every column flagged `primaryKey`),
but entity-level `update`/`remove`/`find` on a table with a composite key throw instead of
matching rows by only one key column; use raw SQL for those tables.

## License

MIT