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
- Works in Node.js, browsers, and serverless
- File-based or in-memory databases
- WAL mode enabled by default
- Full CRUD, migrations, scaffold support

## License

MIT