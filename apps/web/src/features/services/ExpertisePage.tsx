import { zodResolver } from '@hookform/resolvers/zod';
import { expertiseSchema } from '@salon/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { toastError } from '@/app/providers';
import { Button, IconButton } from '@/components/ui/button';
import { Card, EmptyState, ErrorState, InlineNotice, PageHeader, Skeleton } from '@/components/ui/display';
import { Field, FormError, Input, Textarea } from '@/components/ui/form';
import { Menu, Modal, useConfirm } from '@/components/ui/overlay';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { qk, useExpertise } from '@/lib/queries';

type Skill = NonNullable<ReturnType<typeof useExpertise>['data']>[number];
type FormIn = z.input<typeof expertiseSchema>;
type FormOut = z.output<typeof expertiseSchema>;

/** Skills such as "Hair colouring" or "Bridal makeup". Services ask for skills; team members have them. */
export function Component() {
  const manage = useCan()('services.manage');
  const confirm = useConfirm();
  const client = useQueryClient();
  const q = useExpertise();
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/expertise/${id}`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: qk.expertise }); void client.invalidateQueries({ queryKey: ['staff'] }); void client.invalidateQueries({ queryKey: ['services'] }); toast.success('Skill removed'); },
    onError: toastError,
  });

  return (
    <div>
      <PageHeader title="Expertise" description="The skills your team has. Link skills to services and the right people are suggested automatically when booking." actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add skill</Button>} />
      <InlineNotice tone="info" title="How it works">Give a service the skill it needs, give team members that skill, and booking will only offer people who can do the job. You can still fine-tune individuals under Team → Assign services.</InlineNotice>
      <div className="mt-4">
        {q.isLoading && <div role="status" aria-label="Loading skills" className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && q.data.length === 0 && <Card><EmptyState title="No skills yet" description="Add skills like Hair cutting, Colouring or Bridal makeup." action={manage && <Button onClick={() => setEditing('new')}>Add skill</Button>} /></Card>}
        {q.data && q.data.length > 0 && (
          <Card padded={false}>
            <ul className="divide-y divide-line">
              {q.data.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1"><p className="font-medium">{s.name}</p>{s.description && <p className="truncate text-sm text-muted">{s.description}</p>}</div>
                  <p className="hidden text-sm text-muted sm:block">{s.staffCount} team · {s.serviceCount} services</p>
                  {manage && (
                    <Menu label={`Actions for ${s.name}`} trigger={<IconButton label={`Actions for ${s.name}`} size="sm"><MoreHorizontal className="size-5" /></IconButton>} items={[
                      { label: 'Rename', icon: <Pencil className="size-4" />, onSelect: () => setEditing(s) },
                      { label: 'Remove', icon: <Archive className="size-4" />, tone: 'danger', onSelect: async () => { if (await confirm({ title: `Remove “${s.name}”?`, body: `${s.staffCount} team members and ${s.serviceCount} services will lose this skill. Bookings already made are not affected.`, confirmLabel: 'Remove skill', cancelLabel: 'Keep it', tone: 'danger' })) archive.mutate(s.id); } },
                    ]} />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      {editing && <SkillModal skill={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SkillModal({ skill, onClose }: { skill: Skill | null; onClose: () => void }) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormIn, unknown, FormOut>({ resolver: zodResolver(expertiseSchema), defaultValues: { name: skill?.name ?? '', description: skill?.description ?? '' } });
  const save = useMutation({
    mutationFn: (body: FormOut) => (skill ? api.put(`/expertise/${skill.id}`, body) : api.post('/expertise', body)),
    onSuccess: () => { void client.invalidateQueries({ queryKey: qk.expertise }); toast.success(skill ? 'Skill updated' : 'Skill added'); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError) for (const [path, message] of Object.entries(e.fieldErrors)) form.setError(path as keyof FormIn, { message });
      setError(friendlyError(e).message);
    },
  });
  const submit = form.handleSubmit((body) => { setError(null); save.mutate(body); });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={skill ? `Rename ${skill.name}` : 'Add skill'} size="sm" persistent footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={save.isPending}>{skill ? 'Save changes' : 'Add skill'}</Button></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Skill name" required error={form.formState.errors.name?.message}><Input autoFocus placeholder="e.g. Hair colouring" {...form.register('name')} /></Field>
        <Field label="Description" optional><Textarea rows={2} {...form.register('description')} /></Field>
      </form>
    </Modal>
  );
}
