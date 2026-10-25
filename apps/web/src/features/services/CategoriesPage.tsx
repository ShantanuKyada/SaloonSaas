import { zodResolver } from '@hookform/resolvers/zod';
import { categorySchema } from '@salon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { toastError } from '@/app/providers';
import { Button, IconButton } from '@/components/ui/button';
import { Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/display';
import { Field, FormError, Input, Textarea } from '@/components/ui/form';
import { Menu, Modal, useConfirm } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { qk, useCategories } from '@/lib/queries';

type Category = NonNullable<ReturnType<typeof useCategories>['data']>[number];
type FormIn = z.input<typeof categorySchema>;
type FormOut = z.output<typeof categorySchema>;

const SWATCHES = ['#8b5cf6', '#ec4899', '#f43f5e', '#f59e0b', '#10b981', '#0ea5e9', '#6366f1', '#64748b'];

export function Component() {
  const manage = useCan()('services.manage');
  const confirm = useConfirm();
  const client = useQueryClient();
  const q = useCategories();
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/service-categories/${id}`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: qk.categories }); toast.success('Category archived'); },
    onError: toastError,
  });

  return (
    <div>
      <PageHeader title="Service categories" description="Groups that keep your service list tidy, such as Hair, Skin and Nails." actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add category</Button>} />
      {q.isLoading && <div role="status" aria-label="Loading categories" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && <Card><EmptyState title="No categories yet" description="Create a category first, then add services into it." action={manage && <Button onClick={() => setEditing('new')}>Add category</Button>} /></Card>}
      {q.data && q.data.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.map((c) => (
            <li key={c.id} className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card">
              <span className="mt-1 size-3.5 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{c.name}</p>
                <p className="text-sm text-muted">{c.serviceCount} {c.serviceCount === 1 ? 'service' : 'services'}</p>
                {c.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{c.description}</p>}
              </div>
              {manage && (
                <Menu label={`Actions for ${c.name}`} trigger={<IconButton label={`Actions for ${c.name}`} size="sm"><MoreHorizontal className="size-5" /></IconButton>} items={[
                  { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => setEditing(c) },
                  { label: 'Archive', icon: <Archive className="size-4" />, tone: 'danger', onSelect: async () => { if (await confirm({ title: `Archive “${c.name}”?`, body: c.serviceCount > 0 ? `It still has ${c.serviceCount} services. Move them to another category first.` : 'The category will disappear from the list. Nothing else changes.', confirmLabel: 'Archive category', cancelLabel: 'Keep it', tone: 'danger' })) archive.mutate(c.id); } },
                ]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <CategoryModal category={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CategoryModal({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({ resolver: zodResolver(categorySchema), defaultValues: { name: category?.name ?? '', description: category?.description ?? '', color: category?.color ?? SWATCHES[0], sortOrder: category?.sortOrder ?? 0 } });
  const color = form.watch('color');
  const save = useMutation({
    mutationFn: (body: FormOut) => (category ? api.put(`/service-categories/${category.id}`, body) : api.post('/service-categories', body)),
    onSuccess: () => { void client.invalidateQueries({ queryKey: qk.categories }); toast.success(category ? 'Category updated' : 'Category added'); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof FormIn, { message });
      setError(friendlyError(e).message);
    },
  });
  const submit = form.handleSubmit((body) => { setError(null); save.mutate(body); });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={category ? `Edit ${category.name}` : 'Add category'} size="sm" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={save.isPending}>{category ? 'Save changes' : 'Add category'}</Button></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Name" required error={form.formState.errors.name?.message}><Input autoFocus placeholder="e.g. Hair" {...form.register('name')} /></Field>
        <Field label="Description" optional><Textarea rows={2} {...form.register('description')} /></Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Colour on the calendar</legend>
          <div className="flex flex-wrap gap-2">
            {SWATCHES.map((c) => <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={color === c} onClick={() => form.setValue('color', c, { shouldDirty: true })} className={`size-8 rounded-full border-2 ${color === c ? 'border-fg' : 'border-transparent'}`} style={{ background: c }} />)}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
