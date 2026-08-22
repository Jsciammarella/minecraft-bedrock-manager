export default function PasswordPolicyHints({ policy, showUsername = false }) {
  if (!policy) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-mc-textMuted list-disc pl-4">
      {showUsername && (
        <>
          <li>Usernames must be unique and cannot be changed later.</li>
          <li>
            Usernames must be {policy.usernameMin}–{policy.usernameMax} characters and may only use {policy.usernameAllowed}.
          </li>
        </>
      )}
      <li>
        Passwords must be at least {policy.minLength} characters and no more than {policy.maxLength} characters.
      </li>
      {policy.requireUpper && <li>Must include an uppercase letter.</li>}
      {policy.requireLower && <li>Must include a lowercase letter.</li>}
      {policy.requireNumber && <li>Must include a number.</li>}
      {policy.requireSpecial && <li>Must include a special character (anything other than a letter or number).</li>}
      {policy.history > 0 && (
        <li>
          Cannot reuse the last {policy.history} password{policy.history === 1 ? '' : 's'}.
        </li>
      )}
      <li>Passwords cannot contain control characters.</li>
    </ul>
  );
}
