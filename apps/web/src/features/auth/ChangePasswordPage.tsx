import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema, type ChangePasswordInput } from '@salon/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, InlineNotice, PageHeader } from '@/components/ui/display';
import { Field, FormError, Input } from '@/components/ui/form';
import { api, ApiError } from '@/lib/api';
import { homePath, useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

export function Component() {
  const { user, reloadUser } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema), defaultValues: { currentPassword: '', newPassword: '' } });
  const forced = user?.mustChangePassword;

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api.post('/auth/change-password', v);
      await reloadUser();
      toast.success('Password changed');
      navigate(user ? homePath(user) : '/', { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.fieldErrors.currentPassword) form.setError('currentPassword', { message: e.fieldErrors.currentPassword });
      else setError(friendlyError(e).message);
    }
  });

  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Change password" description="Use at least 10 characters with a letter and a number." />
      {forced && <div className="mb-4"><InlineNotice tone="warning" title="Please choose your own password">Your manager set a temporary one. Choose a new password to continue.</InlineNotice></div>}
      <Card>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormError message={error} />
          <Field label="Current password" error={form.formState.errors.currentPassword?.message}>
            <Input type="password" autoComplete="current-password" {...form.register('currentPassword')} />
          </Field>
          <Field label="New password" error={form.formState.errors.newPassword?.message}>
            <Input type="password" autoComplete="new-password" {...form.register('newPassword')} />
          </Field>
          <div className="flex justify-end gap-2">
            {!forced && <Button variant="outline" onClick={() => navigate(-1)}>Cancel</Button>}
            <Button type="submit" loading={form.formState.isSubmitting}>Save new password</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
