import type { AnyExportedSpan } from '@mastra/core/observability';

import { SpanType, TracingEventType } from '@mastra/core/observability';
import { Observability } from '@mastra/observability';
import { expect, spyOn, test } from 'bun:test';

import * as fantasyConfig from '../../../lib/fantasy/config';
import { fantasyWeeklyRecapWorkflow } from '../fantasy-weekly-recap';

test('scheduled recap creates an exported attempt trace without scheduler context', async () => {
	const entry = fantasyWeeklyRecapWorkflow.stepGraph[0];
	if (entry?.type !== 'step')
		throw new Error('weekly recap step missing');
	const spans: AnyExportedSpan[] = [];
	const observability = new Observability({
		configs: {
			default: {
				serviceName: 'test',
				exporters: [{
					name: 'capture',
					onTracingEvent(event) {
						if (event.type === TracingEventType.SPAN_ENDED)
							spans.push(event.exportedSpan);
					},
					exportTracingEvent: async () => {},
					flush: async () => {},
					shutdown: async () => {},
				}],
			},
		},
	});
	const config = spyOn(fantasyConfig, 'getFantasyConfig').mockReturnValue(null);
	try {
		const logger = { info: () => {} };
		const result = await entry.step.execute!({
			mastra: { observability, getLogger: () => logger },
			tracingContext: undefined,
		} as never);
		expect(result).toMatchObject({ outcome: 'skipped-unconfigured' });
		await observability.flush();
		const attempt = spans.find(span => span.name === 'fantasy-weekly-recap-attempt');
		expect(attempt?.type).toBe(SpanType.WORKFLOW_RUN);
		expect(attempt?.traceId).toMatch(/^[a-f0-9]{32}$/);
		const withoutTracing = await entry.step.execute!({
			mastra: { observability: { getDefaultInstance: () => undefined }, getLogger: () => logger },
			tracingContext: undefined,
		} as never);
		expect(withoutTracing).toMatchObject({ outcome: 'skipped-unconfigured' });
	} finally {
		config.mockRestore();
		await observability.shutdown();
	}
});
