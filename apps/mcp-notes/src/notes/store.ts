import Database from "better-sqlite3";

export interface NoteSummary {
  id: number;
  title: string;
  /** The first characters of the body, so a list shows what each note is about without the whole text. */
  preview: string;
  created_at: string;
}

export interface Note {
  id: number;
  title: string;
  body: string;
  created_at: string;
}

const PREVIEW_CHARS = 100;

// Opens (and if needed creates) the database file and makes sure the table exists.
// Pass ":memory:" for a throwaway database (tests).
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  // WAL: readers do not block the writer. Its two side files (-wal, -shm) are created next to the
  // database, which is why the whole DIRECTORY must be writable, not just one file.
  db.pragma("journal_mode = WAL");
  // Wait up to 5 s for a lock instead of failing at once with "database is locked".
  db.pragma("busy_timeout = 5000");
  // SQLite's temporary files go to /tmp by default; the container's filesystem is read-only, so
  // keep them in memory instead.
  db.pragma("temp_store = MEMORY");
  // IF NOT EXISTS makes this safe to run on every start. When the schema has to change later,
  // this is the place a real migration step goes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

// All SQL lives here. Every value reaches SQLite through a `?` placeholder, never through string
// concatenation, so a note titled "'; DROP TABLE notes; --" is just text.
export class NotesStore {
  constructor(private readonly db: Database.Database) {}

  create(title: string, body: string, createdAt: string): NoteSummary {
    const info = this.db.prepare("INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)").run(title, body, createdAt);
    return { id: Number(info.lastInsertRowid), title, preview: body.slice(0, PREVIEW_CHARS), created_at: createdAt };
  }

  // Newest first. `offset` pages through older notes.
  list(limit: number, offset: number): NoteSummary[] {
    return this.db
      .prepare(`SELECT id, title, substr(body, 1, ${PREVIEW_CHARS}) AS preview, created_at FROM notes ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as NoteSummary[];
  }

  get(id: number): Note | undefined {
    return this.db.prepare("SELECT id, title, body, created_at FROM notes WHERE id = ?").get(id) as Note | undefined;
  }

  // Case-insensitive "contains" on title and body. instr() is a plain substring test, so characters
  // that are special in LIKE (% and _) need no escaping. Limit: SQLite's lower() only folds ASCII,
  // so "É" and "é" are different letters here.
  search(query: string, limit: number): NoteSummary[] {
    return this.db
      .prepare(
        `SELECT id, title, substr(body, 1, ${PREVIEW_CHARS}) AS preview, created_at FROM notes
         WHERE instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0
         ORDER BY id DESC LIMIT ?`,
      )
      .all(query, query, limit) as NoteSummary[];
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
  }

  /** Throws if the database cannot be used. Used by /readyz. */
  ping(): void {
    this.db.prepare("SELECT 1").get();
  }
}
