export function PageError({ message = 'Failed to load data. Please refresh.' }: { message?: string }) {
  return (
    <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}
