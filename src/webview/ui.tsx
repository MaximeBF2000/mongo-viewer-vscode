import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export function Icon({ name, spin }: { name: string; spin?: boolean }) {
  return <i class={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} aria-hidden="true" />;
}

export function IconButton(props: {
  icon: string; title: string; onClick?: (e: MouseEvent) => void; disabled?: boolean; active?: boolean; danger?: boolean; label?: string; class?: string;
}) {
  return (
    <button
      type="button"
      class={`icon-btn${props.active ? ' active' : ''}${props.danger ? ' danger' : ''}${props.label ? ' with-label' : ''} ${props.class ?? ''}`}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={(e) => { e.stopPropagation(); props.onClick?.(e); }}
    >
      <Icon name={props.icon} />
      {props.label && <span>{props.label}</span>}
    </button>
  );
}

export function Button(props: {
  onClick?: () => void; children: ComponentChildren; primary?: boolean; disabled?: boolean; title?: string; danger?: boolean; type?: 'button' | 'submit';
}) {
  return (
    <button
      type={props.type ?? 'button'}
      class={`btn${props.primary ? ' primary' : ''}${props.danger ? ' danger' : ''}`}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

// Context menus ---------------------------------------------------------------

export interface MenuItem {
  label?: string;
  icon?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

let openMenuImpl: ((x: number, y: number, items: MenuItem[]) => void) | undefined;

export function openMenu(e: MouseEvent, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  const target = e.currentTarget as HTMLElement | null;
  if (e.type === 'click' && target?.getBoundingClientRect) {
    const r = target.getBoundingClientRect();
    openMenuImpl?.(r.left, r.bottom + 2, items);
  } else {
    openMenuImpl?.(e.clientX, e.clientY, items);
  }
}

export function MenuHost() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [focus, setFocus] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  openMenuImpl = (x, y, items) => { setFocus(-1); setMenu({ x, y, items }); };

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4));
    const y = menu.y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : menu.y;
    ref.current.style.left = `${x}px`;
    ref.current.style.top = `${y}px`;
    ref.current.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  if (!menu) return null;
  const selectable = menu.items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
  return (
    <div class="menu-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
      <div
        class="menu"
        role="menu"
        tabIndex={-1}
        ref={ref}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setMenu(null);
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const pos = selectable.indexOf(focus);
            const next = e.key === 'ArrowDown' ? pos + 1 : pos - 1;
            setFocus(selectable[(next + selectable.length) % selectable.length]);
          } else if (e.key === 'Enter' && focus >= 0) {
            const it = menu.items[focus];
            setMenu(null);
            it.onSelect?.();
          }
        }}
      >
        {menu.items.map((it, i) =>
          it.separator ? (
            <div class="menu-sep" key={i} />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              class={`menu-item${it.danger ? ' danger' : ''}${focus === i ? ' focused' : ''}`}
              disabled={it.disabled}
              onMouseEnter={() => setFocus(i)}
              onClick={() => { setMenu(null); it.onSelect?.(); }}
            >
              <span class="menu-icon">{it.icon && <Icon name={it.icon} />}</span>
              <span class="menu-label">{it.label}</span>
              {it.hint && <span class="menu-hint">{it.hint}</span>}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

// Dialogs ---------------------------------------------------------------------

export function Dialog(props: { title: string; children: ComponentChildren; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('textarea, input, select')?.focus();
  }, []);
  return (
    <div class="dialog-backdrop" onMouseDown={props.onClose}>
      <div
        class="dialog"
        role="dialog"
        aria-label={props.title}
        ref={ref}
        style={props.width ? { width: `${props.width}px` } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose();
        }}
      >
        <div class="dialog-title">{props.title}</div>
        {props.children}
      </div>
    </div>
  );
}

export const formatNumber = (n: number) => n.toLocaleString('en-US');

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

export function formatCompact(n: number): string {
  if (n < 10000) return formatNumber(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '')}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
}

let idCounter = 0;
export const newRequestId = () => `r${Date.now().toString(36)}${idCounter++}`;
