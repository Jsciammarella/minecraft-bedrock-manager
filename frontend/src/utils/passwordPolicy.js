export const DEFAULT_PASSWORD_POLICY = {
  minLength: 6,
  maxLength: 200,
  history: 0,
  requireUpper: false,
  requireLower: false,
  requireNumber: false,
  requireSpecial: false,
  usernameMin: 2,
  usernameMax: 64,
  usernamePattern: '^[a-zA-Z0-9._-]+$',
  usernameAllowed: 'letters, numbers, periods, underscores, and hyphens',
};

export function usernamePattern(policy = DEFAULT_PASSWORD_POLICY) {
  try {
    return new RegExp(policy.usernamePattern || DEFAULT_PASSWORD_POLICY.usernamePattern);
  } catch {
    return new RegExp(DEFAULT_PASSWORD_POLICY.usernamePattern);
  }
}

export function validateUsername(value, policy = DEFAULT_PASSWORD_POLICY) {
  const username = String(value || '').trim();
  const min = policy.usernameMin || DEFAULT_PASSWORD_POLICY.usernameMin;
  const max = policy.usernameMax || DEFAULT_PASSWORD_POLICY.usernameMax;
  if (!username) return 'Username is required';
  if (username.length < min || username.length > max) {
    return `Username must be ${min}-${max} characters`;
  }
  if (!usernamePattern(policy).test(username)) {
    return `Username can only contain ${policy.usernameAllowed}`;
  }
  return '';
}

export function validatePassword(value, policy = DEFAULT_PASSWORD_POLICY, { confirm, required = true } = {}) {
  const password = String(value || '');
  if (!password) return required ? 'Password is required' : '';
  if (/[\x00-\x1F\x7F]/.test(password)) return 'Password cannot contain control characters';
  if (password.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters`;
  }
  if (password.length > policy.maxLength) {
    return `Password cannot be longer than ${policy.maxLength} characters`;
  }
  if (policy.requireUpper && !/[A-Z]/.test(password)) return 'Password must include an uppercase letter';
  if (policy.requireLower && !/[a-z]/.test(password)) return 'Password must include a lowercase letter';
  if (policy.requireNumber && !/[0-9]/.test(password)) return 'Password must include a number';
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password)) return 'Password must include a special character';
  if (confirm != null && password !== confirm) return 'Passwords do not match';
  return '';
}

export function validateLogin(username, password, policy = DEFAULT_PASSWORD_POLICY) {
  const usernameError = validateUsername(username, policy);
  if (usernameError) return usernameError;
  if (!String(password || '')) return 'Password is required';
  if (String(password).length > (policy.maxLength || 200)) {
    return `Password cannot be longer than ${policy.maxLength || 200} characters`;
  }
  return '';
}
