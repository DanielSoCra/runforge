'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { togglePlugin } from '@/actions/plugins';

interface PluginCardProps {
  repoId: string;
  pluginId: string;
  name: string;
  description: string;
  tags: string[];
  active: boolean;
  recommended?: boolean;
  recommendationReason?: string | null;
  confidence?: 'high' | 'medium' | 'low' | null;
}

const CONFIDENCE_COLORS = {
  high: 'bg-green-900 text-green-300',
  medium: 'bg-yellow-900 text-yellow-300',
  low: 'bg-zinc-800 text-zinc-400',
} as const;

export function PluginCard({
  repoId, pluginId, name, description, tags,
  active: initialActive, recommended, recommendationReason, confidence,
}: PluginCardProps) {
  const [active, setActive] = useState(initialActive);
  const [loading, setLoading] = useState(false);

  async function handleToggle(next: boolean) {
    setActive(next); // optimistic
    setLoading(true);
    const result = await togglePlugin(repoId, pluginId, next);
    if (result.error) setActive(!next); // revert on failure
    setLoading(false);
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900">
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
        <div>
          <CardTitle className="text-sm font-medium text-zinc-100">{name}</CardTitle>
          <p className="mt-1 text-xs text-zinc-400">{description}</p>
        </div>
        <Switch checked={active} onCheckedChange={handleToggle} disabled={loading} />
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex flex-wrap gap-1">
          {tags.map(tag => (
            <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
          ))}
          {recommended && confidence && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className={`text-xs ${CONFIDENCE_COLORS[confidence]}`}>{confidence}</Badge>
              </TooltipTrigger>
              {recommendationReason && (
                <TooltipContent><p>{recommendationReason}</p></TooltipContent>
              )}
            </Tooltip>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
