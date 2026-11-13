'use strict';

// Explicit opt-in to plaintext HTTP; works in PowerShell, cmd and POSIX shells.
process.env.CODEX_MAX_HTTP_ONLY = '1';
require('../server');
