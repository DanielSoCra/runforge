'use client';

import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button variant="outline" size="sm" type="submit" disabled={pending}>
      {pending ? 'Sent…' : 'Re-analyze repo'}
    </Button>
  );
}

export function TriggerRecommendationForm({ action }: { action: () => Promise<void> }) {
  return (
    <form action={action}>
      <SubmitButton />
    </form>
  );
}
