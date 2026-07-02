'use client';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';

export interface EscalationTrendRow {
  weekStart: string;
  deploymentId: string;
  raised: number;
  answered: number;
  autoMerges: number;
  operatorTouchesPerDelivered: number | null;
}

interface EscalationTrendChartProps {
  data: EscalationTrendRow[];
}

function formatWeek(value: string): string {
  return value.slice(0, 10);
}

export function EscalationTrendChart({ data }: EscalationTrendChartProps) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Escalation rate vs. operator touches per delivered change</h3>
      {data.length === 0 ? (
        <p className="text-muted-foreground text-sm py-4">No escalation trend data available.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="weekStart"
              tickFormatter={formatWeek}
              tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
            />
            <Tooltip
              contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
              labelFormatter={(label) => formatWeek(String(label))}
            />
            <Legend />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="raised"
              name="Escalations / week"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="operatorTouchesPerDelivered"
              name="Operator touches per delivered"
              stroke="hsl(25 95% 53%)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
