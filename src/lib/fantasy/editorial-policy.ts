export const FANTASY_EDITORIAL_MODEL = 'openai-codex/gpt-6-astra';
export const FANTASY_EDITORIAL_WORKFLOW_ID = 'prepare_fantasy_recap';
export const FANTASY_EDITORIAL_LIMITS = Object.freeze({
	revisions: 2,
	callMs: 120_000,
	totalMs: 480_000,
	assignmentChars: 1_000_000,
});

export function fantasyEditorialDefaults() {
	return {
		maxSteps: 1,
		toolCallConcurrency: 1,
		modelSettings: { maxRetries: 0, timeout: { totalMs: FANTASY_EDITORIAL_LIMITS.callMs, stepMs: FANTASY_EDITORIAL_LIMITS.callMs } },
		providerOptions: { openai: { reasoningEffort: 'xhigh', parallelToolCalls: false } },
		tracingOptions: { hideInput: true, hideOutput: true },
	};
}
