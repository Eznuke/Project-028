'use strict';

/**
 * Safe math expression evaluator (recursive descent). It never uses eval/Function,
 * so user input cannot execute code.
 *
 * Supports: + - * / % ^ ( ) , decimals, scientific notation, constants (pi, e, tau)
 * and functions (sqrt, cbrt, abs, sin, cos, tan, asin, acos, atan, log, ln, exp, floor, ceil, round, min, max, pow).
 * Trigonometric functions use radians.
 */
const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const FUNCTIONS = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

const MAX_LENGTH = 200;
const MAX_DEPTH = 40;

function tokenize(input) {
  const text = input.replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '');
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m = rest.match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
    if (m) {
      tokens.push({ type: 'num', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    m = rest.match(/^[a-z]+/i);
    if (m) {
      tokens.push({ type: 'id', value: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^(),'.includes(rest[0])) {
      tokens.push({ type: 'op', value: rest[0] });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character "${rest[0]}"`);
  }
  return tokens;
}

function evaluate(input) {
  const source = String(input ?? '');
  if (!source.trim()) throw new Error('Enter an expression, for example `2*(3+4)`.');
  if (source.length > MAX_LENGTH) throw new Error(`The expression is too long (max ${MAX_LENGTH} characters).`);

  const tokens = tokenize(source);
  let pos = 0;
  let depth = 0;

  const peek = () => tokens[pos];
  const isOp = (v) => peek()?.type === 'op' && peek().value === v;
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new Error('The expression is nested too deeply.');
  };
  const leave = () => { depth--; };

  function parseExpression() {
    enter();
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    leave();
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[pos++].value;
      const right = parseUnary();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Division by zero.');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }

  function parseUnary() {
    if (isOp('-')) { pos++; enter(); const v = -parseUnary(); leave(); return v; }
    if (isOp('+')) { pos++; enter(); const v = parseUnary(); leave(); return v; }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (isOp('^')) {
      pos++;
      enter();
      const exponent = parseUnary(); // right associative
      leave();
      return Math.pow(base, exponent);
    }
    return base;
  }

  function parsePrimary() {
    const t = tokens[pos];
    if (!t) throw new Error('The expression ended unexpectedly.');
    if (t.type === 'num') { pos++; return t.value; }
    if (t.type === 'id') {
      pos++;
      if (isOp('(')) {
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new Error(`Unknown function "${t.value}".`);
        pos++;
        const args = [];
        if (!isOp(')')) {
          do { args.push(parseExpression()); } while (isOp(',') && pos++);
        }
        if (!isOp(')')) throw new Error('Missing closing parenthesis.');
        pos++;
        if (args.length === 0) throw new Error(`${t.value}() needs an argument.`);
        return fn(...args);
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, t.value)) return CONSTANTS[t.value];
      throw new Error(`Unknown name "${t.value}".`);
    }
    if (t.type === 'op' && t.value === '(') {
      pos++;
      const v = parseExpression();
      if (!isOp(')')) throw new Error('Missing closing parenthesis.');
      pos++;
      return v;
    }
    throw new Error(`Unexpected "${t.value}".`);
  }

  const result = parseExpression();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}".`);
  if (!Number.isFinite(result)) throw new Error('The result is not a finite number.');
  return result;
}

/** Formats a number without floating-point noise (0.1+0.2 -> 0.3). */
function formatResult(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toLocaleString('en-US', { useGrouping: false });
  const rounded = Number(n.toPrecision(12));
  if (Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-6 && rounded !== 0)) return rounded.toExponential(6);
  return String(rounded);
}

module.exports = { evaluate, formatResult };
