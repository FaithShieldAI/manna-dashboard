'use strict';
/** Usage: node scripts/migrate.js — applies pending migrations. */
const { migrate } = require('../src/db');
migrate();
// eslint-disable-next-line no-console
console.log('[migrate] up to date');
