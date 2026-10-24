import { Mastra } from '@mastra/core';

/** Internal native procedures share gateways/tracing, never application storage or checkpoints. */
export class StorageFreeRuntime extends Mastra {
	constructor(private readonly parent: Mastra) {
		super({ logger: parent.getLogger(), gateways: parent.listGateways() });
	}

	override getStorage() { return undefined; }

	override get observability() { return this.parent?.observability ?? super.observability; }
}
