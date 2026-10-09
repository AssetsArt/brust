// Reached from client code only through a non-builtin module: the compiler sees `./secrets`.
import { readFileSync } from 'node:fs'
export const SECRET = `SECRET_${typeof readFileSync}`
