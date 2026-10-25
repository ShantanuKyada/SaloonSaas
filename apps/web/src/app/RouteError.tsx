import { RefreshCw } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';

/** Last-resort screen for a page that crashed or failed to load (for example after a new version was deployed). */
export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const chunk = error instanceof Error && /dynamically imported module|Importing a module script failed|Loading chunk/i.test(error.message);
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center" role="alert">
      <h1 className="text-xl font-semibold">{notFound ? 'We could not find that page' : chunk ? 'A new version is available' : 'Something went wrong on this page'}</h1>
      <p className="mt-2 text-muted">{chunk ? 'Please reload to get the latest version. Nothing you saved is lost.' : 'Your data is safe. Reload the page, or go back and try again. If it keeps happening, tell the person who looks after your salon software.'}</p>
      <div className="mt-6 flex justify-center gap-2"><Button icon={<RefreshCw className="size-4" />} onClick={() => window.location.reload()}>Reload</Button><Button variant="outline" onClick={() => window.history.back()}>Go back</Button></div>
    </div>
  );
}
