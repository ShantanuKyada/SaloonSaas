import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '@/lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'soft';
export type ButtonSize = 'sm' | 'md' | 'lg';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover shadow-card',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border border-line',
  outline: 'border border-line-strong bg-surface text-fg hover:bg-surface-2',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90',
  soft: 'bg-primary-soft text-primary-soft-fg hover:opacity-90',
};
const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-base gap-2',
};

export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string) {
  return cn('inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition-colors select-none disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11', variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  /** Keyboard shortcut hint shown on wide screens, e.g. "N". */
  hotkey?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', size = 'md', loading, icon, hotkey, className, children, disabled, type = 'button', ...props }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClasses(variant, size, className)} {...props}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {hotkey && <kbd className="ml-1 hidden rounded border border-current/30 px-1 text-[10px] leading-4 opacity-70 lg:inline">{hotkey}</kbd>}
    </button>
  );
});

export function ButtonLink({ variant = 'primary', size = 'md', icon, className, children, ...props }: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link className={buttonClasses(variant, size, className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: ButtonVariant; size?: ButtonSize }>(function IconButton({ label, variant = 'ghost', size = 'md', className, children, type = 'button', ...props }, ref) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={cn(buttonClasses(variant, 'sm', className), size === 'md' ? 'size-10 px-0 max-md:size-11' : 'size-9 px-0')} {...props}>
      {children}
    </button>
  );
});
