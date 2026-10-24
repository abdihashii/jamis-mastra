import type { RequestContext } from '@mastra/core/request-context';

import { Mastra } from '@mastra/core';
import { createTool, noopObserve } from '@mastra/core/tools';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { GmailSearchResult } from '../../tools/gmail-search';

import { createSpecialistTools } from '../../specialist-invocations';
import { createSpecialistContext, recordAccountsGmailRead, requireAccountsReplySource, resolveAccountsGmailReferences, revokeSpecialistAuthority } from '../../tools/invoke-specialist';
import { linearCreateProposalTool } from '../../tools/linear';
import { personalAccountsModelHandbackSchema, personalAccountsResultSchema, resolvePersonalAccountsHandback, validatePersonalAccountsHandback } from '../personal-accounts-handback';
import { specialistHandbackSchema } from '../specialist-handback';
import { boundaryModel, jamisFixtureContext } from './specialist-boundary.fixture';

const message = { subject: 'Fixture', from: 'fixture@example.invalid', date: '2026-10-10T18:00:00.000Z', snippet: 'A & B', body: 'Exact body.\n\n$12.34\tkeep spacing.' };
const receipt = (): GmailSearchResult => ({ estimatedTotal: 1, messages: [{ ...message }] });
function modelResult(messageRefs: string[]) {
	return { summary: 'Available evidence.', messageRefs, events: [], issues: [], coverage: [{ source: 'gmail' as const, status: 'complete' as const, gaps: [] as string[] }], research: null, replyText: null };
}
const resolvedSchema = specialistHandbackSchema(personalAccountsResultSchema);

test('native receipts are immutable, invocation-scoped, and cannot be minted through another owner', () => {
	const context = createSpecialistContext({ kind: 'agent', id: 'personal-accounts-agent' });
	const other = createSpecialistContext({ kind: 'agent', id: 'personal-accounts-agent' });
	const raw = receipt();
	const read = recordAccountsGmailRead(context, raw);
	const refs = [...read.messageRefs!];
	expect(new Set([...refs, ...recordAccountsGmailRead(other, receipt()).messageRefs!]).size).toBe(2);
	raw.messages[0]!.body = 'Changed after capture.';
	read.messageRefs![0] = randomUUID();
	expect(resolveAccountsGmailReferences(context, refs)).toEqual([message]);
	const resolved = resolveAccountsGmailReferences(context, refs);
	resolved[0]!.body = 'Changed after resolution.';
	expect(resolveAccountsGmailReferences(context, refs)).toEqual([message]);
	expect(() => resolveAccountsGmailReferences(other, refs)).toThrow('unavailable');
	expect(() => resolveAccountsGmailReferences(context, [randomUUID()])).toThrow('unavailable');
	expect(() => resolveAccountsGmailReferences(context, [...refs, ...refs])).toThrow('duplicates');
	expect(recordAccountsGmailRead(undefined, receipt()).messageRefs).toBeUndefined();
	const weather = createSpecialistContext({ kind: 'agent', id: 'weather-agent' });
	expect(recordAccountsGmailRead(weather, receipt()).messageRefs).toBeUndefined();
	revokeSpecialistAuthority(context);
	expect(() => resolveAccountsGmailReferences(context, refs)).toThrow('unavailable');
	revokeSpecialistAuthority(other);
	revokeSpecialistAuthority(weather);
});

test('references resolve before unchanged record, omission, and coverage guards', () => {
	const context = createSpecialistContext({ kind: 'agent', id: 'personal-accounts-agent' });
	const raw = receipt();
	const read = recordAccountsGmailRead(context, raw);
	const toolResults = [{ payload: { toolName: 'gmailSearchTool', result: read } }];
	const input = { case: 'completed', result: modelResult(read.messageRefs!) };
	const handback = resolvedSchema.parse(resolvePersonalAccountsHandback(input, context));
	expect(handback).toMatchObject({ result: { messages: [{ ...message, truncated: false }] } });
	validatePersonalAccountsHandback(handback, { toolResults });
	const omitted = resolvedSchema.parse(
		resolvePersonalAccountsHandback({ ...input, result: modelResult([]) }, context),
	);
	expect(() => validatePersonalAccountsHandback(omitted, { toolResults })).toThrow('cannot omit');
	if (handback.case !== 'completed')
		throw new Error('Fixture completion required.');
	handback.result.messages[0]!.body = 'Altered by an adapter.';
	expect(() => validatePersonalAccountsHandback(handback, { toolResults })).toThrow('do not match');
	for (const extra of [{ messages: [message] }, { body: 'Override' }]) {
		expect(personalAccountsModelHandbackSchema.safeParse({
			...input,
			result: { ...input.result, ...extra },
		}).success).toBe(false);
	}
	expect(personalAccountsModelHandbackSchema.safeParse({ ...input, result: modelResult(['invented']) }).success).toBe(false);
	const missing = { ...message, body: undefined };
	const mixed = recordAccountsGmailRead(context, { estimatedTotal: 3, messages: [message, missing, { ...message, body: 'Partial\n... (truncated)' }] });
	const partial = { case: 'partial', result: { ...modelResult(mixed.messageRefs!), coverage: [{ source: 'gmail', status: 'unavailable', gaps: ['One body is missing; another is truncated.'] }] }, gaps: ['Incomplete source coverage.'] };
	const mixedResults = [{ payload: { toolName: 'gmailSearchTool', result: mixed } }];
	validatePersonalAccountsHandback(
		resolvedSchema.parse(resolvePersonalAccountsHandback(partial, context)),
		{ toolResults: mixedResults },
	);
	for (const changed of [{ ...partial, case: 'completed', gaps: undefined }, { ...partial, result: { ...partial.result, coverage: input.result.coverage } }]) {
		const resolved = resolvePersonalAccountsHandback(JSON.parse(JSON.stringify(changed)), context);
		expect(
			() => validatePersonalAccountsHandback(resolvedSchema.parse(resolved), { toolResults: mixedResults }),
		).toThrow();
	}
	revokeSpecialistAuthority(context);
});

test('linked source references retain single-message, complete-body, caller, and original-assignment requirements', () => {
	const requestContext = createSpecialistContext({ kind: 'agent', id: 'personal-accounts-agent' });
	const context = { requestContext, observe: noopObserve, agent: { agentId: 'personal-accounts-agent', toolCallId: 'fixture', messages: [], suspend: async () => {} } };
	for (const messages of [[{ ...message, body: undefined }], [{ ...message, body: 'Partial\n... (truncated)' }], [message, message], [{ ...message, body: '' }], [{ ...message, body: 'x'.repeat(4001) }]]) {
		const read = recordAccountsGmailRead(requestContext, { estimatedTotal: messages.length, messages });
		expect(() => requireAccountsReplySource(context, read.messageRefs![0]!)).toThrow('one usable email');
	}
	const read = recordAccountsGmailRead(requestContext, receipt());
	expect(() => requireAccountsReplySource({ ...context, agent: { ...context.agent, agentId: 'jamis' } }, read.messageRefs![0]!)).toThrow('native Accounts caller');
	expect(() => requireAccountsReplySource(context, read.messageRefs![0]!)).toThrow('original Accounts task');
	const proposal = { action: 'create', title: 'Fixture', description: 'Fixture', replySourceRef: read.messageRefs![0] };
	expect(
		(linearCreateProposalTool.inputSchema as z.ZodType).safeParse({ ...proposal, replySource: message }).success,
	).toBe(false);
	revokeSpecialistAuthority(requestContext);
	expect(() => requireAccountsReplySource(context, read.messageRefs![0]!)).toThrow('unavailable');
});

test('configured native Accounts resolves model references and revokes them after handback', async () => {
	let context: RequestContext | undefined;
	const result = modelResult([]);
	const read = createTool({
		id: 'gmail-search',
		description: 'Read a synthetic receipt.',
		inputSchema: z.object({}).strict(),
		execute: async (_, execution) => {
			context = execution.requestContext!;
			const output = recordAccountsGmailRead(context, receipt());
			result.messageRefs = output.messageRefs!;
			return output;
		},
	});
	const tools = createSpecialistTools(new Mastra({ logger: false }), { personalAccounts: {
		tools: { gmailSearchTool: read },
		model: boundaryModel([{ tool: 'gmailSearchTool', input: {} }, { handback: { case: 'completed', result } }]),
	} });
	const caller = jamisFixtureContext();
	const handback = await tools.invoke_personal_accounts.execute!({ question: 'Read this synthetic email.' }, caller);
	expect(handback).toMatchObject({ case: 'completed', result: { messages: [{ ...message, truncated: false }] } });
	expect(JSON.stringify(handback)).not.toContain(result.messageRefs[0]!);
	expect(() => resolveAccountsGmailReferences(context!, result.messageRefs)).toThrow('unavailable');
	revokeSpecialistAuthority(caller.requestContext!);
});
