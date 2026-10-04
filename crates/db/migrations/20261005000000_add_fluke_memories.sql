-- Memoria de Fluke embebida (J3, reemplaza Honcho): lo que Fluke aprendió
-- del usuario a lo largo de las conversaciones. La escribe Fluke mismo con
-- sus herramientas remember / forget; se busca con FTS5 (viene en el SQLite
-- embebido), sin servicios externos ni keys.

CREATE TABLE fluke_memories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fact         TEXT    NOT NULL,
    kind         TEXT    NOT NULL DEFAULT 'fact'
                 CHECK (kind IN ('preference', 'decision', 'fact')),
    created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'subsec')),
    last_used_at TEXT    NULL,
    uses         INTEGER NOT NULL DEFAULT 0
);

-- Índice de texto completo sobre `fact`, sincronizado por triggers.
CREATE VIRTUAL TABLE fluke_memories_fts USING fts5(
    fact,
    content = 'fluke_memories',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER fluke_memories_ai AFTER INSERT ON fluke_memories BEGIN
    INSERT INTO fluke_memories_fts (rowid, fact) VALUES (new.id, new.fact);
END;

CREATE TRIGGER fluke_memories_ad AFTER DELETE ON fluke_memories BEGIN
    INSERT INTO fluke_memories_fts (fluke_memories_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
END;

CREATE TRIGGER fluke_memories_au AFTER UPDATE OF fact ON fluke_memories BEGIN
    INSERT INTO fluke_memories_fts (fluke_memories_fts, rowid, fact) VALUES ('delete', old.id, old.fact);
    INSERT INTO fluke_memories_fts (rowid, fact) VALUES (new.id, new.fact);
END;
