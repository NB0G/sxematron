import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
export class LibraryDatabase {
    db;
    filename;
    constructor(dataDir) {
        mkdirSync(dataDir, { recursive: true });
        this.filename = path.join(dataDir, 'library.sqlite');
        this.db = new DatabaseSync(this.filename);
        this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS component_codes (code TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS components (
        code TEXT PRIMARY KEY REFERENCES component_codes(code),
        definition TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations(version) VALUES (1);
    `);
    }
    list() {
        const rows = this.db.prepare('SELECT definition FROM components ORDER BY code COLLATE BINARY').all();
        return rows.map(row => JSON.parse(String(row.definition)));
    }
    get(code) {
        const row = this.db.prepare('SELECT definition FROM components WHERE code = ?').get(code);
        return row ? JSON.parse(String(row.definition)) : undefined;
    }
    reserved(code) {
        return !!this.db.prepare('SELECT code FROM component_codes WHERE code = ?').get(code);
    }
    create(component) {
        this.db.prepare('INSERT INTO component_codes(code) VALUES (?)').run(component.component_code);
        this.db.prepare('INSERT INTO components(code, definition) VALUES (?, ?)').run(component.component_code, JSON.stringify(component));
    }
    update(component) {
        this.db.prepare('UPDATE components SET definition = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?').run(JSON.stringify(component), component.component_code);
    }
    remove(code) {
        this.db.prepare('DELETE FROM components WHERE code = ?').run(code);
    }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    close() { this.db.close(); }
}
