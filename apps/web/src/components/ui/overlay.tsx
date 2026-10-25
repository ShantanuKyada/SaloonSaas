import { X } from 'lucide-react';
import { Dialog, DropdownMenu, Popover as RxPopover, Tooltip as RxTooltip } from 'radix-ui';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button, IconButton } from './button';

const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' } as const;

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof sizes;
  /** Prevents closing by clicking outside (forms with unsaved work). */
  persistent?: boolean;
}

/** Centered dialog; becomes a full-height sheet on phones. */
export function Modal({ open, onOpenChange, title, description, children, footer, size = 'md', persistent }: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 data-[state=open]:animate-in" />
        <Dialog.Content
          onInteractOutside={(e) => persistent && e.preventDefault()}
          className={cn('fixed z-50 flex max-h-[92dvh] flex-col bg-surface shadow-pop outline-none', 'inset-x-0 bottom-0 rounded-t-2xl md:inset-auto md:left-1/2 md:top-1/2 md:w-[calc(100vw-2rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl', sizes[size])}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-fg">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-0.5 text-sm text-muted">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close" size="sm">
                <X className="size-5" />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3 sm:flex-row sm:justify-end">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Side panel for creating/editing without losing the page behind it (full screen on phones). */
export function Drawer({ open, onOpenChange, title, description, children, footer, size = 'md', persistent }: OverlayProps) {
  const width = { sm: 'md:max-w-md', md: 'md:max-w-xl', lg: 'md:max-w-3xl', xl: 'md:max-w-5xl' }[size];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45" />
        <Dialog.Content onInteractOutside={(e) => persistent && e.preventDefault()} className={cn('fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface shadow-pop outline-none', width)}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-fg">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-0.5 text-sm text-muted">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{typeof title === 'string' ? title : 'Panel'}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close" size="sm">
                <X className="size-5" />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-col-reverse gap-2 border-t border-line bg-surface px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ───────────── Specific confirmations (never a bare "Are you sure?") ─────────────
export interface ConfirmOptions {
  title: ReactNode;
  /** Say exactly what will happen and to whom. */
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { open: boolean }) | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const confirm = useCallback<ConfirmFn>((options) => {
    setState({ ...options, open: true });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const close = (result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setState((s) => (s ? { ...s, open: false } : s));
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!state?.open}
        onOpenChange={(o) => !o && close(false)}
        title={state?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => close(false)}>
              {state?.cancelLabel ?? 'Keep it'}
            </Button>
            <Button variant={state?.tone === 'danger' ? 'danger' : 'primary'} onClick={() => close(true)}>
              {state?.confirmLabel}
            </Button>
          </>
        }
      >
        <div className="text-sm text-muted">{state?.body}</div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx;
}

// ───────────── Menu, popover, tooltip ─────────────
export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  hidden?: boolean;
  hint?: string;
}

export function Menu({ trigger, items, align = 'end', label }: { trigger: ReactNode; items: Array<MenuItem | 'separator'>; align?: 'start' | 'end'; label?: string }) {
  const visible = items.filter((i) => i === 'separator' || !i.hidden);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild aria-label={label}>
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={6} className="z-50 min-w-48 rounded-xl border border-line bg-surface p-1 shadow-pop">
          {visible.map((item, i) =>
            item === 'separator' ? (
              <DropdownMenu.Separator key={`s${i}`} className="my-1 h-px bg-line" />
            ) : (
              <DropdownMenu.Item
                key={i}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn('flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 max-md:py-3', item.tone === 'danger' ? 'text-danger' : 'text-fg')}
              >
                {item.icon && <span className="text-muted">{item.icon}</span>}
                <span className="flex-1">{item.label}</span>
                {item.hint && <kbd className="text-xs text-faint">{item.hint}</kbd>}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Popover({ trigger, children, align = 'start', className }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'center' | 'end'; className?: string }) {
  return (
    <RxPopover.Root>
      <RxPopover.Trigger asChild>{trigger}</RxPopover.Trigger>
      <RxPopover.Portal>
        <RxPopover.Content align={align} sideOffset={6} collisionPadding={12} className={cn('z-50 w-72 rounded-xl border border-line bg-surface p-3 shadow-pop', className)}>
          {children}
        </RxPopover.Content>
      </RxPopover.Portal>
    </RxPopover.Root>
  );
}

export function Tip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RxTooltip.Provider delayDuration={250}>
      <RxTooltip.Root>
        <RxTooltip.Trigger asChild>{children}</RxTooltip.Trigger>
        <RxTooltip.Portal>
          <RxTooltip.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-lg bg-fg px-2.5 py-1.5 text-xs text-bg shadow-pop">
            {label}
          </RxTooltip.Content>
        </RxTooltip.Portal>
      </RxTooltip.Root>
    </RxTooltip.Provider>
  );
}
