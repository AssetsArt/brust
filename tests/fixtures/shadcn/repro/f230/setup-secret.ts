// F230 security case (Mellow F1): a server-side setup module the routes entry imports. It writes a module no island
// reads, so it must not be shipped to any browser chunk (its literal would be disclosed).
import { CONFIG } from './labels-s'
const TOKEN = 'SECRET-F230-do-not-ship'
CONFIG.mode = TOKEN.length > 0 ? 'configured' : 'default'
