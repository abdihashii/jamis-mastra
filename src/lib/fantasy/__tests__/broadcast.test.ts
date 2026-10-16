import { expect, test } from 'bun:test';
import { createBroadcastTools } from '../broadcast';

test('unconfigured Fantasy owner denies drafting and sending without persistence or effects', async () => {
	const { draftGroupMessage, sendGroupMessage } = createBroadcastTools(null);
	expect(await draftGroupMessage.execute!({ note: 'x', text: 'y' }, {} as never)).toMatchObject({ ok: false });
	expect(await sendGroupMessage.execute!({ draftId: 'abcdef12' }, {} as never)).toMatchObject({ ok: false, outcome: 'blocked' });
});
