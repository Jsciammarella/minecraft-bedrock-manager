class SecurityError extends Error {
  constructor(message, { status = 403, code = 'SECURITY' } = {}) {
    super(message);
    this.name = 'SecurityError';
    this.status = status;
    this.code = code;
  }
}

function unauthorized(message = 'Authentication required') {
  return new SecurityError(message, { status: 401, code: 'UNAUTHENTICATED' });
}

function forbidden(message = 'You do not have permission to do that', extra = {}) {
  const err = new SecurityError(message, { status: 403, code: extra.code || 'FORBIDDEN' });
  if (extra.permission) err.permission = extra.permission;
  return err;
}

function permissionRequired(permission, message = 'You do not have permission to do that') {
  return forbidden(message, { code: 'PERMISSION_REQUIRED', permission });
}

function permissionMigrationFailed(migrationKey, schemaVersion, cause) {
  const err = new SecurityError(
    `Permission migration "${migrationKey}" failed`,
    { status: 500, code: 'PERMISSION_MIGRATION_FAILED' },
  );
  err.migrationKey = migrationKey;
  err.schemaVersion = schemaVersion;
  err.cause = cause;
  if (cause?.message) err.originalMessage = cause.message;
  return err;
}

module.exports = {
  SecurityError,
  unauthorized,
  forbidden,
  permissionRequired,
  permissionMigrationFailed,
};
