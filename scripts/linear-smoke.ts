import process from 'node:process';
import { createLinearClient, LinearError } from '../src/lib/linear';

try {
	const evidence = await createLinearClient().readIdentityAndTeam();
	console.log(JSON.stringify(evidence, null, 2));
}
catch (error) {
	console.error(error instanceof LinearError ? error.message : 'Linear smoke failed.');
	process.exitCode = 1;
}
