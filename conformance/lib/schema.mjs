// Minimal JSON Schema (2020-12 subset) validator, enough for spec/signaling.schema.json. No dependencies.
// Supported: $ref (local #/...), type (string or array), const, enum, required, properties, additionalProperties (schema),
// propertyNames.maxLength, maxProperties, items, minItems, minLength, maxLength, pattern, minimum, maximum,
// oneOf, anyOf. Everything else is ignored (annotations such as description).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const signalingSchema = JSON.parse(readFileSync(join(here, '..', '..', 'spec', 'signaling.schema.json'), 'utf8'));

const typeOk = (t, v) => {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    default: return true;
  }
};

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref.slice(2).split('/').reduce((o, k) => o[k], root);
}

// Returns an array of error strings (empty = valid).
export function validate(schema, value, root = signalingSchema, path = '$') {
  const errs = [];
  if (schema.$ref) errs.push(...validate(resolve(root, schema.$ref), value, root, path));
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!ts.some((t) => typeOk(t, value))) { errs.push(`${path}: expected ${ts.join('|')}, got ${JSON.stringify(value)?.slice(0, 40)}`); return errs; }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && [...value].length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: ${JSON.stringify(value)} !~ ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${path}: < ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${path}: > ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  }
  if (typeOk('object', value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}: missing "${k}"`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in value) errs.push(...validate(s, value[k], root, `${path}.${k}`));
    if (schema.maxProperties != null && Object.keys(value).length > schema.maxProperties) errs.push(`${path}: more than ${schema.maxProperties} properties`);
    if (schema.propertyNames?.maxLength != null) for (const k of Object.keys(value)) if ([...k].length > schema.propertyNames.maxLength) errs.push(`${path}: key "${k.slice(0, 10)}..." too long`);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const k of Object.keys(value)) if (!(k in (schema.properties ?? {}))) errs.push(...validate(schema.additionalProperties, value[k], root, `${path}.${k}`));
    }
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(s, value, root, path).length === 0).length;
    if (ok !== 1) errs.push(`${path}: matches ${ok} of oneOf (expected exactly 1)`);
  }
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, value, root, path).length === 0)) errs.push(`${path}: matches none of anyOf`);
  return errs;
}

const byT = (prefix, m) => {
  const def = m && typeof m.t === 'string' ? signalingSchema.$defs[prefix + m.t] : null;
  return def ? validate(def, m) : [`$: unknown message type ${JSON.stringify(m?.t)}`];
};
export const validateClient = (m) => byT('c_', m);
export const validateServer = (m) => byT('s_', m);
