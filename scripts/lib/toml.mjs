/**
 * The TOML subset that registry/<id>.toml files use, without a dependency:
 *
 *   # comment
 *   key = "basic string"          (escapes \" \\ \n \t \uXXXX)
 *   key = 'literal string'
 *   key = ["a", 'b']               (strings only; may span lines; trailing comma ok)
 *
 * Top-level bare keys only: no tables, dotted keys, numbers, booleans, dates
 * or multi-line strings. Anything else is an error naming the line, so a
 * registration that would need more of TOML is rejected instead of being
 * misread.
 */

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export class TomlError extends Error {}

export function parseToml(text) {
  const result = Object.create(null);
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let index = 0;
  const fail = (message) => {
    throw new TomlError(`line ${index + 1}: ${message}`);
  };

  // A cursor over the remaining text of the current line (and following
  // lines while an array is open).
  let rest = "";
  const skipSpace = (allowNewlines) => {
    for (;;) {
      rest = rest.replace(/^[ \t]+/, "");
      if (rest.startsWith("#")) rest = "";
      if (rest || !allowNewlines) return;
      if (++index >= lines.length) fail("unterminated array");
      rest = lines[index];
    }
  };

  const string = () => {
    const quote = rest[0];
    if (quote === "'") {
      const end = rest.indexOf("'", 1);
      if (end < 0) fail("unterminated string");
      const value = rest.slice(1, end);
      rest = rest.slice(end + 1);
      return value;
    }
    if (quote !== '"') fail("expected a string");
    if (rest.startsWith('"""')) fail("multi-line strings are not supported");
    let value = "";
    for (let i = 1; i < rest.length; i++) {
      const char = rest[i];
      if (char === '"') {
        rest = rest.slice(i + 1);
        return value;
      }
      if (char !== "\\") {
        if (char < " " && char !== "\t") fail("control character in string");
        value += char;
        continue;
      }
      const next = rest[++i];
      const simple = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r" }[next];
      if (simple !== undefined) value += simple;
      else if (
        next === "u" &&
        /^[0-9A-Fa-f]{4}$/.test(rest.slice(i + 1, i + 5))
      ) {
        value += String.fromCharCode(parseInt(rest.slice(i + 1, i + 5), 16));
        i += 4;
      } else fail(`unsupported escape \\${next ?? ""}`);
    }
    fail("unterminated string");
  };

  const value = () => {
    if (rest[0] === '"' || rest[0] === "'") return string();
    if (rest[0] !== "[") fail("value must be a string or an array of strings");
    rest = rest.slice(1);
    const items = [];
    for (;;) {
      skipSpace(true);
      if (rest[0] === "]") {
        rest = rest.slice(1);
        return items;
      }
      items.push(string());
      skipSpace(true);
      if (rest[0] === ",") rest = rest.slice(1);
      else if (rest[0] !== "]") fail("expected , or ] in array");
    }
  };

  for (; index < lines.length; index++) {
    rest = lines[index];
    skipSpace(false);
    if (!rest) continue;
    if (rest.startsWith("[")) fail("tables are not supported");
    const equals = rest.indexOf("=");
    if (equals < 0) fail("expected key = value");
    const key = rest.slice(0, equals).trim();
    if (!BARE_KEY.test(key)) fail(`"${key}" is not a bare key`);
    if (key in result) fail(`duplicate key "${key}"`);
    rest = rest.slice(equals + 1);
    skipSpace(false);
    result[key] = value();
    skipSpace(false);
    if (rest) fail("unexpected text after the value");
  }
  return { ...result };
}
