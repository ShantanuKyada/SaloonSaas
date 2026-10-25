// Minimal Prometheus exposition (counters + histograms) without a third-party client.

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
}

class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, value = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) lines.push(`${this.name}${key ? `{${key}}` : ''} ${value}`);
    return lines.join('\n');
  }
}

class Histogram {
  private series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
  ) {}
  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.bounds.forEach((b, i) => {
      if (value <= b) s!.buckets[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const prefix = key ? `${key},` : '';
      this.bounds.forEach((b, i) => lines.push(`${this.name}_bucket{${prefix}le="${b}"} ${s.buckets[i]}`));
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  httpRequests: new Counter('http_requests_total', 'HTTP requests by method, route and status'),
  httpDuration: new Histogram('http_request_duration_seconds', 'HTTP request latency', [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]),
  httpErrors: new Counter('http_errors_total', 'HTTP 5xx responses by route'),
  slowRequests: new Counter('http_slow_requests_total', 'Requests slower than 1s by route'),
  authFailures: new Counter('auth_failures_total', 'Failed authentications by reason'),
  appointmentConflicts: new Counter('appointment_conflicts_total', 'Rejected bookings due to staff conflicts'),
  dbErrors: new Counter('db_errors_total', 'Unexpected database errors by SQLSTATE'),
  notificationsSent: new Counter('notifications_sent_total', 'Notifications delivered to a provider by channel'),
  notificationsFailed: new Counter('notifications_failed_total', 'Notification attempts that failed by channel'),
  jobRuns: new Counter('jobs_runs_total', 'Background job runs by job and outcome'),
  integrationFailures: new Counter('integration_failures_total', 'External integration failures by kind'),
};

export function renderMetrics(): string {
  const mem = process.memoryUsage();
  const process_lines = [
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${mem.rss}`,
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${Math.round(process.uptime())}`,
  ];
  return [...Object.values(metrics).map((m) => m.render()), ...process_lines].join('\n\n') + '\n';
}
