# Security rules

- Never commit passwords, OTPs, API keys, private keys, channel sessions, customer contacts, production logs, database dumps, or server credentials.
- Use synthetic data in documentation and tests.
- Treat every accidental public secret as compromised; removing it in a later commit is not sufficient.
- Report a suspected exposure privately to the system super administrators and rotate the affected credential immediately.
- Do not open a public issue containing sensitive evidence.
