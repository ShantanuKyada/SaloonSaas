import type { ReactNode } from 'react';
import { Checkbox } from '@/components/ui/form';

export interface MultiSelectItem {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
}

/** A tick-list for choosing several things (services, categories, branches) without a dropdown. */
export function MultiSelectList({ items, selected, onChange, maxHeight = 'max-h-56', emptyText = 'Nothing to choose from yet.' }: { items: MultiSelectItem[]; selected: string[]; onChange: (ids: string[]) => void; maxHeight?: string; emptyText?: string }) {
  if (items.length === 0) return <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">{emptyText}</p>;
  const set = new Set(selected);
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <div className={`scroll-thin ${maxHeight} divide-y divide-line overflow-y-auto rounded-lg border border-line`}>
      {items.map((item) => (
        <div key={item.id} className="px-3 py-2">
          <Checkbox checked={set.has(item.id)} onCheckedChange={(on) => toggle(item.id, on)} label={item.label} description={item.hint} />
        </div>
      ))}
    </div>
  );
}
