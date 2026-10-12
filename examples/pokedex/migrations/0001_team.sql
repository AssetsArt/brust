-- pokedex team roster (lib/team-db.sqlite.ts TEAM_DDL; the same table on D1)
CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_name TEXT NOT NULL, num TEXT NOT NULL, types TEXT NOT NULL, artwork TEXT NOT NULL, added_at INTEGER NOT NULL);
