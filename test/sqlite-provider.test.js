'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getSelectorField, parsePredicate } = require('@romatech/orm');
const { SqliteProvider } = require('../dist');

function queryObject(predicates, orderings = [], extra = {}) {
  return {
    includes: [],
    predicates,
    whereExpressions: predicates.map(p => parsePredicate(p)).filter(Boolean),
    orderings: orderings.map(selector => ({ selector, direction: 'asc' })),
    orderByExpressions: orderings
      .map(selector => ({ field: getSelectorField(selector), direction: 'asc' }))
      .filter(e => e.field),
    ...extra
  };
}

async function usersProvider() {
  const provider = new SqliteProvider(':memory:');
  await provider.connect('');
  await provider.createTable({
    tableName: 'users',
    columns: [
      { name: 'id', tsType: 'number', primaryKey: true },
      { name: 'tenant', tsType: 'string' },
      { name: 'isAdmin', tsType: 'number' }
    ]
  });
  await provider.addRange([
    { id: 1, tenant: 'a', isAdmin: 0 },
    { id: 2, tenant: 'b', isAdmin: 0 },
    { id: 3, tenant: 'a', isAdmin: 0 }
  ], 'users');
  await provider.saveChanges();
  return provider;
}

test('executeQuery(QueryObject) applies where, order, skip and take', async () => {
  const provider = await usersProvider();
  const rows = await provider.executeQuery('users', queryObject([u => u.tenant === 'a'], [u => u.id], { skip: 1, take: 5 }));
  assert.deepEqual(rows.map(r => r.id), [3]);

  // Predicates the parser cannot translate are still applied client-side.
  const wanted = 2;
  const closure = await provider.executeQuery('users', queryObject([u => u.id === wanted]));
  assert.deepEqual(closure.map(r => r.id), [2]);
  await provider.disconnect();
});

test('entity keys are quoted as identifiers (no SQL injection through column names)', async () => {
  const provider = await usersProvider();
  await provider.update({ id: 1, 'isAdmin"=1, "tenant"=? WHERE "id"=? OR 1=1 --': 'x' }, 'users');
  await assert.rejects(() => provider.saveChanges(), /no such column/);
  const admins = (await provider.getAll('users')).filter(r => r.isAdmin === 1);
  assert.deepEqual(admins, []);
  await provider.disconnect();
});

test('Date values are stored and undefined properties are skipped', async () => {
  const provider = await usersProvider();
  await provider.add({ id: 9, tenant: new Date(Date.UTC(2020, 0, 2)), isAdmin: undefined }, 'users');
  await provider.saveChanges();
  const row = await provider.find({ id: 9 }, 'users');
  assert.equal(row.tenant, '2020-01-02T00:00:00.000Z');
  assert.equal(row.isAdmin, null);
  await provider.disconnect();
});

test('a failed saveChanges rolls back the whole batch and the provider stays usable', async () => {
  const provider = await usersProvider();
  await provider.add({ id: 10, tenant: 'c' }, 'users');
  await provider.add({ id: 1, tenant: 'duplicate' }, 'users');
  await assert.rejects(() => provider.saveChanges(), /UNIQUE constraint failed/);
  assert.equal(await provider.find({ id: 10 }, 'users'), undefined, 'batch must be atomic');

  await provider.add({ id: 11, tenant: 'd' }, 'users');
  await provider.saveChanges();
  assert.equal((await provider.find({ id: 11 }, 'users')).tenant, 'd');
  await provider.disconnect();
});

test('saveChanges works inside a transaction opened with BEGIN and honours ROLLBACK/COMMIT', async () => {
  const provider = await usersProvider();
  await provider.executeQuery('BEGIN', []);
  await provider.add({ id: 20, tenant: 'tx' }, 'users');
  await provider.saveChanges();
  await provider.executeQuery('ROLLBACK', []);
  assert.equal(await provider.find({ id: 20 }, 'users'), undefined);

  await provider.executeQuery('BEGIN', []);
  await provider.add({ id: 21, tenant: 'tx' }, 'users');
  await provider.saveChanges();
  await provider.executeQuery('COMMIT', []);
  assert.equal((await provider.find({ id: 21 }, 'users')).tenant, 'tx');
  await provider.disconnect();
});

test('uses the table primary key instead of assuming "id"', async () => {
  const provider = new SqliteProvider(':memory:');
  await provider.connect('');
  await provider.createTable({
    tableName: 'products',
    columns: [{ name: 'sku', tsType: 'string', primaryKey: true }, { name: 'name', tsType: 'string' }]
  });
  await provider.addRange([{ sku: 'A', name: 'one' }, { sku: 'B', name: 'two' }], 'products');
  await provider.saveChanges();
  await provider.update({ sku: 'A', name: 'uno' }, 'products');
  await provider.remove({ sku: 'B' }, 'products');
  await provider.saveChanges();
  assert.deepEqual(await provider.getAll('products'), [{ sku: 'A', name: 'uno' }]);
  await provider.disconnect();
});

test('rejects update/remove on composite primary keys instead of touching several rows', async () => {
  const provider = new SqliteProvider(':memory:');
  await provider.connect('');
  await provider.executeQuery('CREATE TABLE lines (orderId INTEGER, lineNo INTEGER, qty INTEGER, PRIMARY KEY (orderId, lineNo))', []);
  await assert.rejects(() => provider.remove({ orderId: 1, lineNo: 1 }, 'lines'), /composite primary key/);
  const columns = await provider.getColumnsForTable('lines');
  assert.deepEqual(columns.filter(c => c.primaryKey).map(c => c.name), ['orderId', 'lineNo']);
  await provider.disconnect();
});

test('persists to the file given as connection string, atomically', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roma-sqlite-'));
  const file = path.join(dir, 'app.sqlite');
  try {
    const provider = new SqliteProvider();
    await provider.connect(file);
    await provider.createTable({ tableName: 't', columns: [{ name: 'id', tsType: 'number', primaryKey: true }] });
    await provider.add({ id: 1 }, 't');
    await provider.saveChanges();
    assert.ok(fs.existsSync(file), 'saveChanges must write the database file');
    await provider.disconnect();
    assert.deepEqual(fs.readdirSync(dir), ['app.sqlite'], 'no temporary files are left behind');

    const reopened = new SqliteProvider(file);
    await reopened.connect('');
    assert.deepEqual(await reopened.getAll('t'), [{ id: 1 }]);
    await reopened.disconnect();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Type conversion before the in-memory re-evaluation ───────────────────────

async function peopleProvider() {
  const provider = new SqliteProvider(':memory:');
  await provider.connect('');
  await provider.createTable({
    tableName: 'people',
    columns: [
      { name: 'id', tsType: 'number', primaryKey: true },
      { name: 'active', tsType: 'boolean' },
      { name: 'born', tsType: 'Date' }
    ]
  });
  await provider.addRange([
    { id: 1, active: true, born: new Date(Date.UTC(1990, 0, 1)) },
    { id: 2, active: false, born: new Date(Date.UTC(2005, 5, 1)) },
    { id: 3, active: null, born: null }
  ], 'people');
  await provider.saveChanges();
  return provider;
}

test('boolean columns come back as booleans, so `active === true` keeps its rows', async () => {
  const provider = await peopleProvider();
  const rows = await provider.executeQuery('people', queryObject([p => p.active === true]));
  assert.deepEqual(rows.map(r => r.id), [1]);
  const inactive = await provider.executeQuery('people', queryObject([p => p.active === false]));
  assert.deepEqual(inactive.map(r => r.id), [2]);
  assert.equal((await provider.find({ id: 1 }, 'people')).active, true);
  assert.equal((await provider.getAll('people'))[2].active, null);
  await provider.disconnect();
});

test('date columns come back as Date, so `born > cutoff` keeps its rows', async () => {
  const provider = await peopleProvider();
  const cutoff = new Date(Date.UTC(2000, 0, 1));
  const rows = await provider.executeQuery('people', queryObject([p => p.born > cutoff], [p => p.id]));
  assert.deepEqual(rows.map(r => r.id), [2]);
  const row = await provider.find({ id: 1 }, 'people');
  assert.ok(row.born instanceof Date);
  assert.equal(row.born.toISOString(), '1990-01-01T00:00:00.000Z');
  assert.equal((await provider.find({ id: 3 }, 'people')).born, null);
  await provider.disconnect();
});

test('dates written by SQLite itself (UTC "YYYY-MM-DD HH:MM:SS") are read as UTC', async () => {
  const provider = new SqliteProvider(':memory:');
  await provider.connect('');
  await provider.executeQuery('CREATE TABLE events (id INTEGER PRIMARY KEY, at DATETIME)', []);
  await provider.executeQuery("INSERT INTO events (id, at) VALUES (1, '2024-03-04 05:06:07')", []);
  const [row] = await provider.getAll('events');
  assert.equal(row.at.toISOString(), '2024-03-04T05:06:07.000Z');
  await provider.disconnect();
});

// ─── Composite primary keys ───────────────────────────────────────────────────

test('createTable declares every primaryKey column in the primary key', async () => {
  const provider = new SqliteProvider(':memory:');
  await provider.connect('');
  // MigrationService passes `primaryKey` = first flagged column plus the flags.
  await provider.createTable({
    tableName: 'lines',
    primaryKey: 'orderId',
    columns: [
      { name: 'orderId', tsType: 'number', primaryKey: true },
      { name: 'lineNo', tsType: 'number', primaryKey: true },
      { name: 'qty', tsType: 'number' }
    ]
  });
  const columns = await provider.getColumnsForTable('lines');
  assert.deepEqual(columns.filter(c => c.primaryKey).map(c => c.name), ['orderId', 'lineNo']);
  await provider.addRange([{ orderId: 1, lineNo: 1, qty: 1 }, { orderId: 1, lineNo: 2, qty: 1 }], 'lines');
  await provider.saveChanges();
  await provider.add({ orderId: 1, lineNo: 2, qty: 9 }, 'lines');
  await assert.rejects(() => provider.saveChanges(), /UNIQUE constraint failed/);
  assert.equal((await provider.getAll('lines')).length, 2);
  await provider.disconnect();
});

test('createTable rejects an explicit primaryKey that contradicts the column flags', async () => {
  const provider = new SqliteProvider(':memory:');
  await provider.connect('');
  await assert.rejects(() => provider.createTable({
    tableName: 'bad',
    primaryKey: 'id',
    columns: [{ name: 'id', tsType: 'number' }, { name: 'code', tsType: 'string', primaryKey: true }]
  }), /primary key/i);
  await assert.rejects(() => provider.createTable({
    tableName: 'bad2',
    primaryKey: 'missing',
    columns: [{ name: 'id', tsType: 'number' }]
  }), /primary key/i);
  assert.deepEqual(await provider.getTables(), []);
  await provider.disconnect();
});

// ─── Durability of schema, migration history and raw writes ───────────────────

test('DDL, migration history and raw writes outside a transaction reach the file immediately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roma-sqlite-'));
  const file = path.join(dir, 'app.sqlite');
  try {
    const provider = new SqliteProvider(file);
    await provider.connect('');
    await provider.createTable({ tableName: 't', columns: [{ name: 'id', tsType: 'number', primaryKey: true }] });
    await provider.addMigration('001_init', '');
    await provider.executeQuery('INSERT INTO t (id) VALUES (?)', [7]);

    // A second reader of the file (no disconnect/saveChanges on the first one).
    const reader = new SqliteProvider(file);
    await reader.connect('');
    assert.deepEqual(await reader.getTables(), ['t']);
    assert.deepEqual(await reader.getMigrations(), ['001_init']);
    assert.deepEqual(await reader.getAll('t'), [{ id: 7 }]);
    await reader.disconnect();
    await provider.disconnect();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing written inside an open transaction reaches the file before COMMIT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roma-sqlite-'));
  const file = path.join(dir, 'app.sqlite');
  try {
    const provider = new SqliteProvider(file);
    await provider.connect('');
    await provider.createTable({ tableName: 't', columns: [{ name: 'id', tsType: 'number', primaryKey: true }] });
    await provider.executeQuery('BEGIN', []);
    await provider.executeQuery('INSERT INTO t (id) VALUES (?)', [1]);
    await provider.addMigration('001_tx', '');

    const before = new SqliteProvider(file);
    await before.connect('');
    assert.deepEqual(await before.getAll('t'), []);
    assert.deepEqual(await before.getMigrations(), []);
    await before.disconnect();

    await provider.executeQuery('COMMIT', []);
    const after = new SqliteProvider(file);
    await after.connect('');
    assert.deepEqual(await after.getAll('t'), [{ id: 1 }]);
    await after.disconnect();
    await provider.disconnect();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
