import { Check, ChevronDown, Search, X } from 'lucide-react';
import { Checkbox as RxCheckbox, Switch as RxSwitch } from 'radix-ui';
import { cloneElement, forwardRef, isValidElement, useId, useState, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const control =
  'w-full rounded-lg border bg-surface px-3 text-sm text-fg placeholder:text-faint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70 max-md:text-base';

const stateClass = (invalid?: boolean) => (invalid ? 'border-danger' : 'border-line-strong hover:border-faint');

/** Label + control + hint + error, wired together for screen readers. */
export function Field({ label, hint, error, required, optional, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; optional?: boolean; children: ReactNode; className?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined,
        invalid: !!error,
      })
    : children;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
        {optional && <span className="ml-1 text-xs font-normal text-faint">optional</span>}
      </label>
      {child}
      {hint && !error && <p id={hintId} className="text-xs text-muted">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}

interface InvalidProps {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & InvalidProps & { prefix?: ReactNode; suffix?: ReactNode }>(function Input({ className, invalid, prefix, suffix, ...props }, ref) {
  if (prefix || suffix) {
    return (
      <div className={cn('flex h-10 items-center rounded-lg border bg-surface focus-within:ring-2 focus-within:ring-ring max-md:h-11', stateClass(invalid), className)}>
        {prefix && <span className="pl-3 text-sm text-muted">{prefix}</span>}
        <input ref={ref} aria-invalid={invalid || undefined} className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-fg placeholder:text-faint focus:outline-none max-md:text-base" {...props} />
        {suffix && <span className="pr-3 text-sm text-muted">{suffix}</span>}
      </div>
    );
  }
  return <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-10 max-md:h-11', stateClass(invalid), className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & InvalidProps>(function Textarea({ className, invalid, rows = 3, ...props }, ref) {
  return <textarea ref={ref} rows={rows} aria-invalid={invalid || undefined} className={cn(control, 'py-2', stateClass(invalid), className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & InvalidProps>(function Select({ className, invalid, children, ...props }, ref) {
  return (
    <div className="relative">
      <select ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-10 appearance-none pr-9 max-md:h-11', stateClass(invalid), className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
});

export const DateInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & InvalidProps>(function DateInput({ className, invalid, ...props }, ref) {
  return <input ref={ref} type="date" aria-invalid={invalid || undefined} className={cn(control, 'h-10 max-md:h-11', stateClass(invalid), className)} {...props} />;
});

export const TimeInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & InvalidProps>(function TimeInput({ className, invalid, ...props }, ref) {
  return <input ref={ref} type="time" step={300} aria-invalid={invalid || undefined} className={cn(control, 'h-10 max-md:h-11', stateClass(invalid), className)} {...props} />;
});

/** Amount in rupees on screen, whole paise in the data. */
export function MoneyInput({ value, onChange, currencySymbol = '₹', invalid, id, placeholder = '0', autoFocus, disabled, 'aria-describedby': describedBy, className }: { value: number | null | undefined; onChange: (minor: number | null) => void; currencySymbol?: string; invalid?: boolean; id?: string; placeholder?: string; autoFocus?: boolean; disabled?: boolean; 'aria-describedby'?: string; className?: string }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === null || value === undefined ? '' : String(value / 100));
  return (
    <Input
      id={id}
      aria-describedby={describedBy}
      inputMode="decimal"
      autoFocus={autoFocus}
      disabled={disabled}
      invalid={invalid}
      className={className}
      prefix={currencySymbol}
      placeholder={placeholder}
      value={shown}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d.]/g, '');
        const parts = raw.split('.');
        const cleaned = parts.length > 1 ? `${parts[0]}.${parts.slice(1).join('').slice(0, 2)}` : raw;
        setText(cleaned);
        onChange(cleaned === '' || cleaned === '.' ? null : Math.round(Number(cleaned) * 100));
      }}
      onBlur={() => setText(null)}
    />
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className, autoFocus, id, 'aria-label': ariaLabel }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean; id?: string; 'aria-label'?: string }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input id={id} aria-label={ariaLabel ?? placeholder} autoFocus={autoFocus} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cn(control, 'h-10 border-line-strong pl-9 pr-9 max-md:h-11')} />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted hover:bg-surface-2">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

export function Checkbox({ checked, onCheckedChange, label, description, disabled, id }: { checked: boolean | 'indeterminate'; onCheckedChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className="flex items-start gap-3">
      <RxCheckbox.Root id={cid} checked={checked} disabled={disabled} onCheckedChange={(v) => onCheckedChange(v === true)} className="mt-0.5 grid size-5 shrink-0 place-items-center rounded border border-line-strong bg-surface data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary disabled:opacity-50 max-md:size-6">
        <RxCheckbox.Indicator className="text-primary-fg">
          <Check className="size-3.5" strokeWidth={3} />
        </RxCheckbox.Indicator>
      </RxCheckbox.Root>
      {(label || description) && (
        <label htmlFor={cid} className="cursor-pointer text-sm">
          <span className="font-medium text-fg">{label}</span>
          {description && <span className="block text-xs text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}

export function Switch({ checked, onCheckedChange, label, description, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="cursor-pointer text-sm">
        <span className="font-medium text-fg">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
      <RxSwitch.Root id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full bg-surface-3 transition-colors data-[state=checked]:bg-primary disabled:opacity-50">
        <RxSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px]" />
      </RxSwitch.Root>
    </div>
  );
}

/** Segmented buttons for 2–5 mutually exclusive choices (faster than a dropdown). */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'md' }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; label: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} className={cn('rounded-md px-3 font-medium transition-colors max-md:min-h-10', size === 'sm' ? 'h-8 text-xs' : 'h-9 text-sm', value === o.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}
