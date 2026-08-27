const SCHEMA_VERSION = 1;
const MIGRATION_KEY = 'server_access_control_v1';

function migrate(db) {
  const applied = db.prepare('SELECT 1 AS ok FROM schema_history WHERE migration_key = ?').get(MIGRATION_KEY);
  if (applied) return { skipped: true, version: SCHEMA_VERSION };

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_access_policies (
        server_id INTEGER PRIMARY KEY,
        access_mode TEXT NOT NULL DEFAULT 'inherited'
          CHECK(access_mode IN ('inherited', 'restricted')),
        provider_id TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS server_access_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
        UNIQUE(server_id, name),
        UNIQUE(server_id, slug)
      );

      CREATE TABLE IF NOT EXISTS server_access_group_members (
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES server_access_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS server_access_group_permissions (
        group_id INTEGER NOT NULL,
        permission_key TEXT NOT NULL,
        value TEXT NOT NULL CHECK(value IN ('allow', 'deny')),
        assignment_origin TEXT NOT NULL DEFAULT 'manual',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, permission_key),
        FOREIGN KEY (group_id) REFERENCES server_access_groups(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS server_access_users (
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, user_id),
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS server_access_user_permissions (
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        permission_key TEXT NOT NULL,
        value TEXT NOT NULL CHECK(value IN ('allow', 'deny')),
        assignment_origin TEXT NOT NULL DEFAULT 'manual',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, user_id, permission_key),
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_server_access_groups_server ON server_access_groups(server_id);
      CREATE INDEX IF NOT EXISTS idx_server_access_group_members_user ON server_access_group_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_server_access_group_perms_key ON server_access_group_permissions(permission_key);
      CREATE INDEX IF NOT EXISTS idx_server_access_users_user ON server_access_users(user_id);
      CREATE INDEX IF NOT EXISTS idx_server_access_user_perms_key ON server_access_user_permissions(permission_key);
    `);
    db.prepare(`
      INSERT INTO schema_history (migration_key, schema_version, result)
      VALUES (?, ?, 'ok')
    `).run(MIGRATION_KEY, String(SCHEMA_VERSION));
  });

  run();
  return { skipped: false, version: SCHEMA_VERSION };
}

module.exports = { SCHEMA_VERSION, MIGRATION_KEY, migrate };
