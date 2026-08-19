const SECRET_NAME = /pat|token|password|secret|key|connection|passwd|authorization/i;

export function isSecretKey(name) {
  return SECRET_NAME.test(String(name));
}

export function maskSecret(value) {
  if (value === undefined || value === null || value === "") return value;
  return "***";
}

export function maskRecord(record = {}) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      isSecretKey(key) ? maskSecret(value) : value,
    ]),
  );
}

export function presentKeys(record = {}) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      isSecretKey(key)
        ? Boolean(value)
        : value,
    ]),
  );
}
