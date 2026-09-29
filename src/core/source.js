/**
 * Source loading and the `E0005` encoding contract: `*.xl.md` is UTF-8 without
 * a BOM and uses LF.
 *
 * @module xl/core/source
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diag } from './diagnostics.js'

/**
 * Read one source file and validate its encoding.
 *
 * The file is read as bytes so a BOM and a non-UTF-8 sequence are both
 * observable; decoding the text first would erase the evidence.
 * @param {string} cwd - working directory the path resolves against.
 * @param {string} relPath - POSIX source path.
 * @returns {{text: string, diagnostics: object[]}} the decoded text and any encoding diagnostics.
 */
export function loadSource(cwd, relPath) {
  const absolute = join(cwd, relPath)
  let bytes
  try {
    bytes = readFileSync(absolute)
  } catch (error) {
    return {
      text: '',
      diagnostics: [diag({
        code: 'E2002',
        file: relPath,
        line: 1,
        msg: `cannot read source file: ${error instanceof Error ? error.message : String(error)}`,
      })],
    }
  }
  const diagnostics = []
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    diagnostics.push(diag({
      code: 'E0005',
      file: relPath,
      line: 1,
      col: 1,
      msg: 'source file starts with a UTF-8 BOM; *.xl.md must be UTF-8 without a BOM',
      endCol: 2,
    }))
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      text: '',
      diagnostics: [...diagnostics, diag({
        code: 'E0005',
        file: relPath,
        line: 1,
        col: 1,
        msg: 'source file is not valid UTF-8',
      })],
    }
  }
  const crlf = text.indexOf('\r')
  if (crlf >= 0) {
    const before = text.slice(0, crlf)
    const line = before.split('\n').length
    const column = crlf - (before.lastIndexOf('\n') + 1) + 1
    diagnostics.push(diag({
      code: 'E0005',
      file: relPath,
      line,
      col: column,
      msg: 'source file contains a carriage return; *.xl.md uses LF line endings',
      endCol: column + 1,
    }))
  }
  return { text, diagnostics }
}

/**
 * Line and column of an absolute character offset in a text.
 * @param {string} text - the text.
 * @param {number} offset - character offset.
 * @returns {{line: number, col: number}} the 1-based position.
 */
export function positionOf(text, offset) {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, col: offset - (before.lastIndexOf('\n') + 1) + 1 }
}
