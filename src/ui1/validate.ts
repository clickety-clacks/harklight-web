// The attention-client.ui/1 grammar: custom answer forms. This follows the
// Server's admission check and the iPhone app's parser, which agree on a
// shared conformance corpus. Any fault anywhere makes the whole form
// unsupported; there is no partial rendering.

import { duplicateKeys, integerValue, RawNumber, stringify, utf8Length } from '../relay/json';

export const UI1_SCHEMA = 'attention-client.ui/1';
const REQUIRED = ['schema', 'requires', 'illustrations', 'inputs', 'open', 'resolved', 'submission'];
const OPTIONAL = ['resolvedByState', 'answeredWithResult'];
export const TERMINAL_STATES = ['answered', 'no_comment', 'cleared', 'expired', 'superseded'];

export class Ui1Fault extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}

type Obj = Record<string, unknown>;
type InputKind = 'response' | 'text' | 'point';

interface SceneState {
  count: number;
  openInputCounts: Map<string, number>;
  referenced: Set<string>;
  usesResultPoint: boolean;
}

const invalid = (path: string, reason: string): never => {
  throw new Ui1Fault(path, reason);
};
const require = (ok: boolean, path: string, reason: string) => {
  if (!ok) invalid(path, reason);
};
const childPath = (path: string, key: string) => (path === '$' ? key : `${path}.${key}`);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function object(v: unknown, path: string, message: string): Obj {
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RawNumber)) return v as Obj;
  return invalid(path, message);
}

function array(v: unknown, path: string, message: string): unknown[] {
  return Array.isArray(v) ? v : invalid(path, message);
}

function string(v: unknown, path: string, nonEmpty: boolean, message: string): string {
  if (typeof v !== 'string') return invalid(path, message);
  if (nonEmpty && v === '') invalid(path, message);
  return v;
}

function requiredString(o: Obj, key: string, parent: string, message: string): string {
  if (!has(o, key)) invalid(childPath(parent, key), message);
  return string(o[key], childPath(parent, key), true, message);
}

function identifier(v: unknown, path: string): string {
  const s = string(v, path, true, 'identifier must be non-empty');
  require(utf8Length(s) <= L.identifier_bytes, path, `identifier is at most ${L.identifier_bytes} UTF-8 bytes`);
  return s;
}

function boundedInteger(v: unknown, path: string, min: number, max: number, name: string): void {
  const n = integerValue(v);
  if (n === null) invalid(path, `${name} must be an integer`);
  if (n! < BigInt(min)) invalid(path, `${name} must be an integer from ${min} through ${max}`);
  if (n! > BigInt(max)) invalid(path, `${name} is outside its permitted integer range ${min} through ${max}`);
}

function color(v: unknown, path: string): void {
  const s = string(v, path, true, 'color must be # followed by six hexadecimal digits');
  require(/^#[0-9A-Fa-f]{6}$/.test(s), path, 'color must be # followed by six hexadecimal digits');
}

function exactFields(o: Obj, required: string[], optional: string[], path: string, mismatch: string): void {
  const keys = Object.keys(o);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((k) => !has(o, k)).sort(byCodePoint);
  const extra = keys.filter((k) => !allowed.has(k)).sort(byCodePoint);
  if (missing.length) invalid(childPath(path, missing[0]), `required member ${JSON.stringify(missing[0])} is missing; add it`);
  if (extra.length) invalid(path, `${mismatch}; remove unsupported member ${JSON.stringify(extra[0])}`);
}

function rejectDuplicateKeys(v: unknown, path: string): void {
  if (Array.isArray(v)) {
    v.forEach((c, i) => rejectDuplicateKeys(c, `${path}[${i}]`));
    return;
  }
  if (!v || typeof v !== 'object' || v instanceof RawNumber) return;
  const dups = duplicateKeys(v);
  if (dups.length) invalid(childPath(path, dups[0]), 'object member names must be unique; remove the duplicate member');
  for (const k of Object.keys(v).sort(byCodePoint)) rejectDuplicateKeys((v as Obj)[k], childPath(path, k));
}

/** Validate a delivered form. Throws Ui1Fault on the first fault. */
/** The size and count limits a UI/1 document is checked against. */
export interface Ui1Limits {
  document_bytes: number;
  requires: number;
  illustrations: number;
  primitives_per_illustration: number;
  primitives_total: number;
  inputs: number;
  actions: number;
  scene_nodes: number;
  scene_depth: number;
  result_nodes: number;
  result_depth: number;
  result_point_path: number;
  array_items: number;
  object_members: number;
  identifier_bytes: number;
}

/**
 * The limits Harklight Server publishes to senders (its answer_ui_limits).
 * Every client renders custom answer screens up to them; a screen over them
 * is offered as a plain reply instead.
 */
export const PUBLISHED_UI1_LIMITS: Ui1Limits = {
  document_bytes: 1_048_576,
  requires: 32,
  illustrations: 256,
  primitives_per_illustration: 4_096,
  primitives_total: 16_384,
  inputs: 128,
  actions: 512,
  scene_nodes: 4_096,
  scene_depth: 64,
  result_nodes: 4_096,
  result_depth: 64,
  result_point_path: 64,
  array_items: 4_096,
  object_members: 4_096,
  identifier_bytes: 512,
};

/** The limits the shared conformance corpus was written at (the app's, at the time). */
export const CORPUS_UI1_LIMITS: Ui1Limits = {
  document_bytes: 65_536,
  requires: 8,
  illustrations: 64,
  primitives_per_illustration: 512,
  primitives_total: 512,
  inputs: 16,
  actions: 64,
  scene_nodes: 128,
  scene_depth: 16,
  result_nodes: 128,
  result_depth: 16,
  result_point_path: 16,
  array_items: 128,
  object_members: 128,
  identifier_bytes: 128,
};

/** The published limits, with any the Server sent (GET /v2/me answer_ui_limits) in place of the defaults. */
export function ui1Limits(published: Record<string, number> | null | undefined): Ui1Limits {
  const out = { ...PUBLISHED_UI1_LIMITS };
  for (const k of Object.keys(out) as (keyof Ui1Limits)[]) {
    const v = published?.[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

/** The limits of the validation running now. */
let L: Ui1Limits = PUBLISHED_UI1_LIMITS;

export function validateUi1(document: unknown, deliveredFileNames: string[], limits: Ui1Limits = PUBLISHED_UI1_LIMITS): void {
  const previous = L;
  L = limits;
  try {
    validate(document, deliveredFileNames);
  } finally {
    L = previous;
  }
}

function validate(document: unknown, deliveredFileNames: string[]): void {
  rejectDuplicateKeys(document, '$');
  const root = object(document, '$', 'document must be an object');
  exactFields(root, REQUIRED, OPTIONAL, '$', 'top-level members must match the UI/1 shape');
  const schema = string(root.schema, 'schema', false, 'schema must be a string');
  require(schema === UI1_SCHEMA, 'schema', 'schema must be attention-client.ui/1');

  const bytes = utf8Length(stringify(document, { sortKeys: true }));
  require(bytes <= L.document_bytes, '$', `answer_ui document is ${bytes} bytes; it must be at most ${L.document_bytes} UTF-8 bytes`);

  const requires = array(root.requires, 'requires', 'requires must be a string array');
  require(requires.length > 0, 'requires', 'requires must contain the capabilities used');
  require(requires.length <= L.requires, 'requires', `requires permits at most ${L.requires} capabilities`);
  const required = requires.map((x, i) => string(x, `requires[${i}]`, true, 'each capability must be a non-empty string'));
  const seen = new Set<string>();
  required.forEach((r, i) => {
    require(!seen.has(r), `requires[${i}]`, 'each used capability appears exactly once');
    seen.add(r);
  });

  const files = new Set(deliveredFileNames);
  const { ids: illustrationIds, image } = parseIllustrations(root.illustrations, files, deliveredFileNames);
  const { kinds, refs } = parseInputs(root.inputs, illustrationIds);

  const state: SceneState = { count: 0, openInputCounts: new Map(), referenced: refs, usesResultPoint: false };
  parseScene(root.open, 'open', 1, false, false, true, kinds, illustrationIds, state);
  parseScene(root.resolved, 'resolved', 1, true, false, false, kinds, illustrationIds, state);
  if (has(root, 'resolvedByState')) {
    const states = object(root.resolvedByState, 'resolvedByState', 'resolvedByState must be an object');
    for (const key of Object.keys(states).sort(byCodePoint)) {
      require(TERMINAL_STATES.includes(key), `resolvedByState.${key}`, 'state key must be a known terminal state');
      parseScene(states[key], `resolvedByState.${key}`, 1, true, false, false, kinds, illustrationIds, state);
    }
  }
  if (has(root, 'answeredWithResult')) {
    parseScene(root.answeredWithResult, 'answeredWithResult', 1, true, true, false, kinds, illustrationIds, state);
  }

  const submission = object(root.submission, 'submission', 'submission must be an object');
  exactFields(submission, ['label', 'result'], [], 'submission', 'submission members must match its exact shape');
  string(submission.label, 'submission.label', true, 'submission label must be non-empty');
  const result = { refs: new Set<string>(), count: 0 };
  parseConstructor(submission.result, 'submission.result', 1, kinds, result);
  require(result.count <= L.result_nodes, 'submission.result', `at most ${L.result_nodes} result constructor nodes are allowed`);
  require(state.count <= L.scene_nodes, 'open', `at most ${L.scene_nodes} scene nodes are allowed`);

  const inputIds = [...kinds.keys()];
  const openIds = [...state.openInputCounts.keys()];
  require(
    openIds.length === inputIds.length && inputIds.every((id) => state.openInputCounts.has(id)),
    'open',
    'each declared input must occur exactly once in open',
  );
  const twice = inputIds.find((id) => state.openInputCounts.get(id) !== 1);
  if (twice !== undefined) invalid('open', `input ${JSON.stringify(twice)} must occur exactly once in open`);
  require(inputIds.every((id) => result.refs.has(id)), 'submission.result', 'every input must be used by the result constructor');

  (root.illustrations as Obj[]).forEach((ill, i) => {
    require(state.referenced.has(ill.id as string), `illustrations[${i}]`, 'every illustration must be referenced');
  });

  const expected = new Set(['scene/1', 'result/1']);
  if (illustrationIds.size > 0) expected.add('illustration/1');
  const kindSet = new Set(kinds.values());
  if (kindSet.has('response')) expected.add('response/1');
  if (kindSet.has('text')) expected.add('text/1');
  if (kindSet.has('point')) expected.add('point/1');
  if (state.usesResultPoint) expected.add('result-point/1');
  if (image) expected.add('image/1');
  const got = new Set(required);
  const missing = [...expected].filter((c) => !got.has(c)).sort();
  const extra = [...got].filter((c) => !expected.has(c)).sort();
  if (missing.length || extra.length) {
    const fix =
      missing.length && extra.length
        ? `add "${missing[0]}" and remove "${extra[0]}"`
        : missing.length
          ? `add "${missing[0]}"`
          : `remove "${extra[0]}"`;
    invalid('requires', `requires must list exactly the capabilities used; ${fix}`);
  }
}

function parseIllustrations(value: unknown, files: Set<string>, names: string[]) {
  const values = array(value, 'illustrations', 'illustrations must be an array');
  require(values.length <= L.illustrations, 'illustrations', `at most ${L.illustrations} illustrations are allowed`);
  const ids = new Set<string>();
  let total = 0;
  let image = false;
  values.forEach((raw, index) => {
    const path = `illustrations[${index}]`;
    const item = object(raw, path, 'illustration must be an object');
    exactFields(item, ['id', 'label', 'width', 'height', 'primitives'], [], path, 'illustration members must match the required shape');
    const id = identifier(item.id, `${path}.id`);
    require(!ids.has(id), `${path}.id`, 'illustration identifiers must be unique; use a unique id');
    string(item.label, `${path}.label`, true, 'label must be non-empty');
    boundedInteger(item.width, `${path}.width`, 1, 4096, 'width');
    boundedInteger(item.height, `${path}.height`, 1, 4096, 'height');
    const primitives = array(item.primitives, `${path}.primitives`, 'primitives must be an array');
    require(primitives.length <= L.primitives_per_illustration, `${path}.primitives`, `at most ${L.primitives_per_illustration} primitives are allowed in one illustration`);
    primitives.forEach((p, i) => {
      if (parsePrimitive(p, `${path}.primitives[${i}]`, files, names)) image = true;
    });
    total += primitives.length;
    require(total <= L.primitives_total, 'illustrations', `at most ${L.primitives_total} primitives are allowed across illustrations`);
    ids.add(id);
  });
  return { ids, image };
}

function parsePrimitive(raw: unknown, path: string, files: Set<string>, names: string[]): boolean {
  const p = object(raw, path, 'primitive must be an object');
  const kind = requiredString(p, 'kind', path, 'primitive kind is required');
  switch (kind) {
    case 'rect':
      exactFields(p, ['kind', 'x', 'y', 'width', 'height', 'fill'], [], path, 'rect members must match its exact shape');
      boundedInteger(p.x, `${path}.x`, 0, 4096, 'x');
      boundedInteger(p.y, `${path}.y`, 0, 4096, 'y');
      boundedInteger(p.width, `${path}.width`, 1, 4096, 'width');
      boundedInteger(p.height, `${path}.height`, 1, 4096, 'height');
      color(p.fill, `${path}.fill`);
      return false;
    case 'circle':
      exactFields(p, ['kind', 'cx', 'cy', 'r', 'fill'], [], path, 'circle members must match its exact shape');
      boundedInteger(p.cx, `${path}.cx`, 0, 4096, 'circle center');
      boundedInteger(p.cy, `${path}.cy`, 0, 4096, 'circle center');
      boundedInteger(p.r, `${path}.r`, 1, 4096, 'circle radius');
      color(p.fill, `${path}.fill`);
      return false;
    case 'line':
      exactFields(p, ['kind', 'x1', 'y1', 'x2', 'y2', 'stroke', 'strokeWidth'], [], path, 'line members must match its exact shape');
      for (const k of ['x1', 'y1', 'x2', 'y2']) boundedInteger(p[k], `${path}.${k}`, 0, 4096, k);
      color(p.stroke, `${path}.stroke`);
      boundedInteger(p.strokeWidth, `${path}.strokeWidth`, 1, 64, 'strokeWidth');
      return false;
    case 'text': {
      exactFields(p, ['kind', 'x', 'y', 'text', 'fill', 'fontSize', 'align'], [], path, 'text primitive members must match its exact shape');
      boundedInteger(p.x, `${path}.x`, 0, 4096, 'x');
      boundedInteger(p.y, `${path}.y`, 0, 4096, 'y');
      string(p.text, `${path}.text`, false, 'text must be a string');
      color(p.fill, `${path}.fill`);
      boundedInteger(p.fontSize, `${path}.fontSize`, 1, 256, 'fontSize');
      const align = string(p.align, `${path}.align`, true, 'align must be a non-empty string');
      require(['start', 'middle', 'end'].includes(align), `${path}.align`, 'align must be start, middle, or end');
      return false;
    }
    case 'image': {
      exactFields(p, ['kind', 'x', 'y', 'width', 'height', 'file'], [], path, 'image members must be exactly kind, x, y, width, height, and file');
      boundedInteger(p.x, `${path}.x`, 0, 4096, 'x');
      boundedInteger(p.y, `${path}.y`, 0, 4096, 'y');
      boundedInteger(p.width, `${path}.width`, 1, 4096, 'width');
      boundedInteger(p.height, `${path}.height`, 1, 4096, 'height');
      const file = string(p.file, `${path}.file`, true, 'file must be a non-empty string');
      if (!files.has(file)) invalid(`${path}.file`, `${JSON.stringify(file)} is not one of this message's files (${names.map((n) => JSON.stringify(n)).join(', ')})`);
      return true;
    }
    default:
      return invalid(`${path}.kind`, 'primitive kind must be rect, circle, line, text, or image');
  }
}

function parseInputs(value: unknown, illustrationIds: Set<string>) {
  const inputs = array(value, 'inputs', 'inputs must be an array');
  require(inputs.length <= L.inputs, 'inputs', `at most ${L.inputs} inputs are allowed`);
  const kinds = new Map<string, InputKind>();
  const refs = new Set<string>();
  inputs.forEach((raw, index) => {
    const path = `inputs[${index}]`;
    const input = object(raw, path, 'input must be an object');
    const kind = requiredString(input, 'kind', path, 'input kind is required');
    let id: string;
    if (kind === 'response') {
      exactFields(input, ['kind', 'id', 'label', 'actions'], [], path, 'response input members must match its exact shape');
      id = identifier(input.id, `${path}.id`);
      string(input.label, `${path}.label`, true, 'label must be non-empty');
      const actions = array(input.actions, `${path}.actions`, 'actions must be an array');
      require(actions.length > 0, `${path}.actions`, 'response input requires at least one action');
      require(actions.length <= L.actions, `${path}.actions`, `at most ${L.actions} actions are allowed`);
      parseActions(actions, `${path}.actions`, illustrationIds, refs);
    } else if (kind === 'text') {
      exactFields(input, ['kind', 'id', 'label'], [], path, 'text input members must match its exact shape');
      id = identifier(input.id, `${path}.id`);
      string(input.label, `${path}.label`, true, 'label must be non-empty');
    } else if (kind === 'point') {
      exactFields(input, ['kind', 'id', 'label', 'illustration'], [], path, 'point input members must match its exact shape');
      id = identifier(input.id, `${path}.id`);
      string(input.label, `${path}.label`, true, 'label must be non-empty');
      const ill = identifier(input.illustration, `${path}.illustration`);
      require(illustrationIds.has(ill), `${path}.illustration`, 'point input illustration must name a declared illustration');
      refs.add(ill);
    } else {
      return invalid(`${path}.kind`, 'input kind must be response, text, or point');
    }
    require(!kinds.has(id), `${path}.id`, 'input identifiers must be unique');
    kinds.set(id, kind);
  });
  return { kinds, refs };
}

function parseActions(actions: unknown[], path: string, illustrationIds: Set<string>, refs: Set<string>): void {
  const seen = new Set<string>();
  actions.forEach((raw, index) => {
    const ap = `${path}[${index}]`;
    const action = object(raw, ap, 'action must be an object');
    const kind = requiredString(action, 'kind', ap, 'action kind is required');
    exactFields(action, ['id', 'label', 'kind'], ['value', 'illustration'], ap, 'action members must match its exact shape');
    const id = identifier(action.id, `${ap}.id`);
    require(!seen.has(id), `${ap}.id`, 'action identifiers within a response must be unique');
    string(action.label, `${ap}.label`, true, 'action label must be non-empty');
    if (kind === 'value') require(has(action, 'value'), `${ap}.value`, 'a value action must include value');
    else if (kind === 'text') require(!has(action, 'value'), `${ap}.value`, 'a text action cannot include value');
    else invalid(`${ap}.kind`, 'action kind must be value or text');
    if (has(action, 'illustration')) {
      const ill = identifier(action.illustration, `${ap}.illustration`);
      require(illustrationIds.has(ill), `${ap}.illustration`, 'action illustration must name a declared illustration');
      refs.add(ill);
    }
    seen.add(id);
  });
}

function parseScene(
  raw: unknown,
  path: string,
  depth: number,
  terminal: boolean,
  resultBranch: boolean,
  inOpen: boolean,
  kinds: Map<string, InputKind>,
  illustrationIds: Set<string>,
  state: SceneState,
): void {
  require(depth <= L.scene_depth, path, `scene depth must be at most ${L.scene_depth}`);
  const node = object(raw, path, 'scene node must be an object');
  const kind = requiredString(node, 'kind', path, 'scene kind is required');
  state.count++;
  require(state.count <= L.scene_nodes, path, `at most ${L.scene_nodes} scene nodes are allowed`);
  const children = (label: string) => {
    const list = array(node.children, `${path}.children`, `${label} children must be an array`);
    require(list.length > 0, `${path}.children`, `${label} requires at least one child`);
    list.forEach((c, i) => parseScene(c, `${path}.children[${i}]`, depth + 1, terminal, resultBranch, inOpen, kinds, illustrationIds, state));
  };
  switch (kind) {
    case 'stack': {
      exactFields(node, ['kind', 'axis', 'children'], [], path, 'stack node members must match its exact shape');
      const axis = string(node.axis, `${path}.axis`, true, 'axis must be a non-empty string');
      require(axis === 'vertical' || axis === 'horizontal', `${path}.axis`, 'axis must be vertical or horizontal');
      children('stack');
      return;
    }
    case 'grid':
      exactFields(node, ['kind', 'columns', 'children'], [], path, 'grid node members must match its exact shape');
      boundedInteger(node.columns, `${path}.columns`, 1, 4, 'grid columns');
      children('grid');
      return;
    case 'text': {
      exactFields(node, ['kind', 'text', 'style'], [], path, 'text node members must match its exact shape');
      string(node.text, `${path}.text`, false, 'text must be a string');
      const style = string(node.style, `${path}.style`, true, 'style must be a non-empty string');
      require(['title', 'body', 'caption'].includes(style), `${path}.style`, 'style must be title, body, or caption');
      return;
    }
    case 'illustration': {
      exactFields(node, ['kind', 'id'], [], path, 'illustration scene members must match its exact shape');
      const id = identifier(node.id, `${path}.id`);
      require(illustrationIds.has(id), `${path}.id`, 'illustration identifier must exist');
      state.referenced.add(id);
      return;
    }
    case 'input': {
      exactFields(node, ['kind', 'id', 'layout'], [], path, 'input scene members must match its exact shape');
      require(!terminal, path, 'input scene nodes are not allowed in terminal scenes');
      const id = identifier(node.id, `${path}.id`);
      const inputKind = kinds.get(id);
      require(inputKind !== undefined, `${path}.id`, 'input scene must name a declared input');
      const layout = string(node.layout, `${path}.layout`, true, 'layout must be a non-empty string');
      const ok =
        (inputKind === 'response' && (layout === 'cards' || layout === 'list')) ||
        (inputKind === 'text' && layout === 'editor') ||
        (inputKind === 'point' && layout === 'diagram');
      require(ok, `${path}.layout`, 'input layout must be recognized and compatible with the input kind');
      if (inOpen) state.openInputCounts.set(id, (state.openInputCounts.get(id) ?? 0) + 1);
      return;
    }
    case 'result-point': {
      exactFields(node, ['kind', 'id', 'label', 'path'], [], path, 'result-point members must match its exact shape');
      require(terminal && resultBranch, path, 'result-point is allowed only in the terminal result scene');
      const id = identifier(node.id, `${path}.id`);
      require(illustrationIds.has(id), `${path}.id`, 'illustration identifier must exist');
      string(node.label, `${path}.label`, true, 'label must be non-empty');
      const comps = array(node.path, `${path}.path`, 'result-point path must be an array');
      require(comps.length <= L.result_point_path, `${path}.path`, `result-point path permits at most ${L.result_point_path} components`);
      comps.forEach((c, i) => {
        const cp = `${path}.path[${i}]`;
        if (typeof c === 'string') return;
        const n = integerValue(c);
        if (n === null) invalid(cp, 'path component must be a string or integer index');
        if (n! < 0n || n! > 65_535n) invalid(cp, 'integer path index must be from 0 through 65535');
      });
      state.usesResultPoint = true;
      state.referenced.add(id);
      return;
    }
    default:
      invalid(`${path}.kind`, 'scene kind must be stack, grid, text, illustration, input, or result-point');
  }
}

function parseConstructor(
  raw: unknown,
  path: string,
  depth: number,
  kinds: Map<string, InputKind>,
  acc: { refs: Set<string>; count: number },
): void {
  require(depth <= L.result_depth, path, `result constructor depth must be at most ${L.result_depth}`);
  const node = object(raw, path, 'result constructor must be an object');
  const kind = requiredString(node, 'kind', path, 'result constructor kind is required');
  acc.count++;
  require(acc.count <= L.result_nodes, path, `at most ${L.result_nodes} result constructor nodes are allowed`);
  switch (kind) {
    case 'literal':
      exactFields(node, ['kind', 'value'], [], path, 'literal constructor members must match its exact shape');
      return;
    case 'input': {
      exactFields(node, ['kind', 'id'], [], path, 'input constructor members must match its exact shape');
      const id = identifier(node.id, `${path}.id`);
      require(kinds.has(id), `${path}.id`, 'input constructor must name a declared input');
      acc.refs.add(id);
      return;
    }
    case 'array': {
      exactFields(node, ['kind', 'items'], [], path, 'array constructor members must match its exact shape');
      const items = array(node.items, `${path}.items`, 'array constructor items must be an array');
      require(items.length <= L.array_items, `${path}.items`, `at most ${L.array_items} array items are allowed`);
      items.forEach((it, i) => parseConstructor(it, `${path}.items[${i}]`, depth + 1, kinds, acc));
      return;
    }
    case 'object': {
      exactFields(node, ['kind', 'members'], [], path, 'object constructor members must match its exact shape');
      const members = array(node.members, `${path}.members`, 'object constructor members must be an array');
      require(members.length <= L.object_members, `${path}.members`, `at most ${L.object_members} object members are allowed`);
      const seen = new Set<string>();
      members.forEach((m, i) => {
        const mp = `${path}.members[${i}]`;
        const member = object(m, mp, 'object constructor member must be an object');
        exactFields(member, ['name', 'value'], [], mp, 'object constructor member members must match its exact shape');
        const name = string(member.name, `${mp}.name`, false, 'object member name must be a string');
        require(!seen.has(name), `${mp}.name`, 'object member names must be unique');
        parseConstructor(member.value, `${mp}.value`, depth + 1, kinds, acc);
        seen.add(name);
      });
      return;
    }
    default:
      invalid(`${path}.kind`, 'result constructor kind must be literal, input, array, or object');
  }
}

