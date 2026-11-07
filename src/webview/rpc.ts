import type { RpcError, RpcEvent, RpcResponse } from '../shared/protocol';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

export class RpcFailure extends Error implements RpcError {
  field?: RpcError['field'];
  line?: number;
  col?: number;
  cancelled?: boolean;
  stage?: number;
  constructor(e: RpcError) {
    super(e.message);
    Object.assign(this, e);
  }
}

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: RpcFailure) => void }>();
const listeners = new Set<(event: unknown) => void>();

window.addEventListener('message', (e: MessageEvent<RpcResponse | RpcEvent>) => {
  const msg = e.data;
  if (msg?.type === 'res') {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new RpcFailure(msg.error));
    else p?.resolve(msg.result);
  } else if (msg?.type === 'event') {
    listeners.forEach((l) => l(msg.event));
  }
});

export function onEvent<E>(listener: (event: E) => void): () => void {
  const l = listener as (e: unknown) => void;
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A typed caller for one API. `A` maps method names to [params, result]. */
export function client<A>() {
  return function call<M extends keyof A & string>(
    method: M,
    ...params: A[M] extends [infer P, unknown] ? (P extends void ? [] : [P]) : never
  ): Promise<A[M] extends [unknown, infer R] ? R : never> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      vscode.postMessage({ type: 'req', id, method, params: params[0] });
    });
  };
}

export const getState = <T,>() => (vscode.getState() ?? {}) as Partial<T>;
export const patchState = (patch: Record<string, unknown>) => vscode.setState({ ...(vscode.getState() as object), ...patch });
