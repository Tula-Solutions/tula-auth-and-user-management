/**
 * Password hashes made by someone else, for tests of an import (ADR 0066). Each comes from a
 * public source, so a test that fails on one is a statement about Bun and the parser, not
 * about a hash this repository made.
 */

/** The reference implementation's own example (`argon2` README): "password", salt `somesalt`. */
export const ARGON2I_REFERENCE =
  '$argon2i$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG'

/** PHP's documentation example for `password_verify`: "rasmuslerdorf", cost 7, `$2y$`. */
export const BCRYPT_PHP_COST_7 = '$2y$07$BCryptRequires22Chrcte/VlQH0piJtjXl.0t1XkA8pw9dMXTpOq'
