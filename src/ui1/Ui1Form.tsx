// Draws a custom answer form (attention-client.ui/1): its scene, its
// illustrations and its inputs, as the iPhone app does.

import { useEffect, useRef, useState } from 'preact/hooks';
import { integerValue } from '../relay/json';
import type { WireFile } from '../state/types';
import { actionTextKey, toPoint, type Action, type Draft, type Input, type Point } from './form';

type Obj = Record<string, unknown>;

export interface FormContext {
  doc: Obj;
  draft: Draft;
  /** Null when the form is read-only (a closed message). */
  onDraft: ((d: Draft) => void) | null;
  /** Revision 1's delivered files, which image primitives name. */
  files: WireFile[];
  imageUrl: (f: WireFile) => Promise<string | null>;
}

const num = (v: unknown) => Number(integerValue(v) ?? 0n);

export function Scene({ node, ctx }: { node: Obj; ctx: FormContext }) {
  switch (node.kind) {
    case 'stack': {
      const children = node.children as Obj[];
      return (
        <div class={node.axis === 'horizontal' ? 'u-hstack' : 'u-vstack'}>
          {children.map((c, i) => (
            <Scene key={i} node={c} ctx={ctx} />
          ))}
        </div>
      );
    }
    case 'grid': {
      const cols = num(node.columns);
      return (
        <div class="u-grid" style={{ '--cols': String(cols) }}>
          {(node.children as Obj[]).map((c, i) => (
            <Scene key={i} node={c} ctx={ctx} />
          ))}
        </div>
      );
    }
    case 'text':
      return <p class={`u-text u-text--${String(node.style)}`}>{String(node.text)}</p>;
    case 'illustration': {
      const ill = illustration(ctx.doc, node.id as string);
      return ill ? <Illustration ill={ill} ctx={ctx} /> : null;
    }
    case 'input': {
      const input = (ctx.doc.inputs as Input[]).find((i) => i.id === node.id);
      return input ? <InputView input={input} ctx={ctx} /> : null;
    }
    default:
      // result-point appears only with the person's own answer, which a
      // person's browser does not receive; nothing to draw.
      return null;
  }
}

function illustration(doc: Obj, id: string): Obj | undefined {
  return (doc.illustrations as Obj[]).find((i) => i.id === id);
}

function InputView({ input, ctx }: { input: Input; ctx: FormContext }) {
  const { draft, onDraft } = ctx;
  const set = (patch: Partial<Draft>) => onDraft?.({ ...draft, ...patch });
  if (input.kind === 'text') {
    return (
      <label class="u-input">
        <span class="u-label">{input.label}</span>
        <textarea
          class="u-field"
          rows={4}
          placeholder={input.label}
          value={draft.text[input.id] ?? ''}
          disabled={!onDraft}
          onInput={(e) => set({ text: { ...draft.text, [input.id]: (e.currentTarget as HTMLTextAreaElement).value } })}
        />
      </label>
    );
  }
  if (input.kind === 'point') {
    const ill = illustration(ctx.doc, input.illustration);
    const p = draft.points[input.id];
    return (
      <div class="u-input">
        <span class="u-label">{input.label}</span>
        {ill && (
          <Illustration
            ill={ill}
            ctx={ctx}
            point={p}
            onPoint={onDraft ? (pt) => set({ points: { ...draft.points, [input.id]: pt } }) : undefined}
            pickLabel={input.label}
          />
        )}
        {p && <span class="u-caption">{`Horizontal ${p.x}, vertical ${p.y}`}</span>}
      </div>
    );
  }
  const selected = draft.selected[input.id];
  return (
    <div class="u-input" role="radiogroup" aria-label={input.label}>
      {input.label !== 'Response' && <span class="u-label">{input.label}</span>}
      {input.actions.map((a) => (
        <ActionCard
          key={a.id}
          input={input}
          action={a}
          on={selected === a.id}
          ctx={ctx}
          onPick={() => set({ selected: { ...draft.selected, [input.id]: a.id } })}
          onText={(t) => set({ actionText: { ...draft.actionText, [actionTextKey(input.id, a.id)]: t } })}
        />
      ))}
    </div>
  );
}

function ActionCard(p: {
  input: Input;
  action: Action;
  on: boolean;
  ctx: FormContext;
  onPick: () => void;
  onText: (t: string) => void;
}) {
  const { action, ctx } = p;
  const ill = action.illustration ? illustration(ctx.doc, action.illustration) : undefined;
  const text = ctx.draft.actionText[actionTextKey(p.input.id, action.id)] ?? '';
  const disabled = !ctx.onDraft;
  if (action.kind === 'text' && (p.on || text !== '')) {
    return (
      <div class={p.on ? 'replycard replycard--on' : 'replycard'}>
        <button type="button" role="radio" aria-checked={p.on} class="rc-head" disabled={disabled} onClick={p.onPick}>
          <span class="mark" aria-hidden="true" />
          <span class="ti">{action.label}</span>
        </button>
        <textarea
          class="rc-pane"
          aria-label={action.label}
          value={text}
          readOnly={!p.on}
          disabled={disabled}
          onInput={(e) => p.onText((e.currentTarget as HTMLTextAreaElement).value)}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={p.on}
      class={`choice${p.on ? ' choice--on' : ''}${action.kind === 'text' ? ' choice--text' : ''}`}
      disabled={disabled}
      onClick={p.onPick}
    >
      <span class="choice-col">
        {ill && <Illustration ill={ill} ctx={ctx} />}
        <span class="choice-row">
          <span class="mark" aria-hidden="true" />
          <span class="ti">{action.label}</span>
        </span>
      </span>
    </button>
  );
}

/** An illustration as SVG, scaled to the width it is given. */
export function Illustration(p: {
  ill: Obj;
  ctx: FormContext;
  point?: Point;
  onPoint?: (pt: Point) => void;
  pickLabel?: string;
}) {
  const w = num(p.ill.width);
  const h = num(p.ill.height);
  const svg = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<Point | null>(null);
  const shown = dragging ?? p.point;

  const rectOf = () => {
    const r = svg.current!.getBoundingClientRect();
    // The drawing keeps its aspect ratio inside the element, centred.
    const scale = Math.min(r.width / w, r.height / h);
    const dw = w * scale;
    const dh = h * scale;
    return { left: r.left + (r.width - dw) / 2, top: r.top + (r.height - dh) / 2, width: dw, height: dh };
  };
  const pick = p.onPoint;

  return (
    <svg
      ref={svg}
      class={pick ? 'u-ill u-ill--pick' : 'u-ill'}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={String(p.ill.label)}
      tabIndex={pick ? 0 : undefined}
      aria-description={pick ? 'Click or drag to select a point. Arrow keys move it; Enter sets it at the center.' : undefined}
      onPointerDown={
        pick
          ? (e) => {
              const r = rectOf();
              if (e.clientX < r.left || e.clientX > r.left + r.width || e.clientY < r.top || e.clientY > r.top + r.height) return;
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              setDragging(toPoint(e.clientX, e.clientY, r));
            }
          : undefined
      }
      onPointerMove={pick ? (e) => dragging && setDragging(toPoint(e.clientX, e.clientY, rectOf())) : undefined}
      onPointerUp={
        pick
          ? (e) => {
              if (!dragging) return;
              const pt = toPoint(e.clientX, e.clientY, rectOf());
              setDragging(null);
              pick(pt);
            }
          : undefined
      }
      onPointerCancel={pick ? () => setDragging(null) : undefined}
      onKeyDown={
        pick
          ? (e) => {
              const cur = p.point ?? { x: 500, y: 500 };
              const step = e.shiftKey ? 100 : 10;
              const clamp = (v: number) => Math.min(1000, Math.max(0, v));
              const moves: Record<string, Point> = {
                ArrowLeft: { x: clamp(cur.x - step), y: cur.y },
                ArrowRight: { x: clamp(cur.x + step), y: cur.y },
                ArrowUp: { x: cur.x, y: clamp(cur.y - step) },
                ArrowDown: { x: cur.x, y: clamp(cur.y + step) },
                Enter: { x: 500, y: 500 },
              };
              if (moves[e.key]) {
                e.preventDefault();
                pick(moves[e.key]);
              }
            }
          : undefined
      }
    >
      {(p.ill.primitives as Obj[]).map((prim, i) => (
        <Primitive key={i} prim={prim} ctx={p.ctx} />
      ))}
      {shown && <Marker x={(shown.x * w) / 1000} y={(shown.y * h) / 1000} scale={markerScale(svg.current, w, h)} />}
    </svg>
  );
}

/** Illustration units per screen pixel, so the marker keeps its screen size. */
function markerScale(el: SVGSVGElement | null, w: number, h: number): number {
  const r = el?.getBoundingClientRect();
  if (!r || !r.width || !r.height) return Math.max(w, h) / 400;
  return 1 / Math.min(r.width / w, r.height / h);
}

function Marker({ x, y, scale }: { x: number; y: number; scale: number }) {
  return (
    <g class="u-marker" style={{ '--s': String(scale) }}>
      <line x1={x - 13 * scale} y1={y} x2={x + 13 * scale} y2={y} />
      <line x1={x} y1={y - 13 * scale} x2={x} y2={y + 13 * scale} />
      <circle cx={x} cy={y} r={8 * scale} />
    </g>
  );
}

function Primitive({ prim, ctx }: { prim: Obj; ctx: FormContext }) {
  switch (prim.kind) {
    case 'rect':
      return <rect x={num(prim.x)} y={num(prim.y)} width={num(prim.width)} height={num(prim.height)} fill={String(prim.fill)} />;
    case 'circle':
      return <circle cx={num(prim.cx)} cy={num(prim.cy)} r={num(prim.r)} fill={String(prim.fill)} />;
    case 'line':
      return (
        <line
          x1={num(prim.x1)}
          y1={num(prim.y1)}
          x2={num(prim.x2)}
          y2={num(prim.y2)}
          stroke={String(prim.stroke)}
          stroke-width={num(prim.strokeWidth)}
        />
      );
    case 'text':
      return (
        <text
          x={num(prim.x)}
          y={num(prim.y)}
          fill={String(prim.fill)}
          font-size={num(prim.fontSize)}
          text-anchor={String(prim.align)}
          // The app anchors text at the bottom of its line, not the baseline.
          dominant-baseline="text-after-edge"
          class="u-svg-text"
        >
          {String(prim.text)}
        </text>
      );
    case 'image':
      return <ImagePrimitive prim={prim} ctx={ctx} />;
    default:
      return null;
  }
}

function ImagePrimitive({ prim, ctx }: { prim: Obj; ctx: FormContext }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const file = ctx.files.find((f) => f.name === prim.file);
  useEffect(() => {
    let live = true;
    if (!file) {
      setUrl(null);
      return;
    }
    ctx.imageUrl(file).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [file?.name, file?.upload_id]);
  const x = num(prim.x);
  const y = num(prim.y);
  const w = num(prim.width);
  const h = num(prim.height);
  if (url === undefined) return <rect x={x} y={y} width={w} height={h} class="u-img-loading" />;
  if (url === null)
    return (
      <g>
        <rect x={x} y={y} width={w} height={h} rx={6} class="u-img-missing" />
        <text x={x + w / 2} y={y + h / 2} text-anchor="middle" dominant-baseline="middle" class="u-img-missing-text" font-size={Math.max(10, Math.min(w, h) / 10)}>
          Picture could not be shown
        </text>
      </g>
    );
  return <image href={url} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" />;
}
