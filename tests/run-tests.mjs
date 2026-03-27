import assert from 'node:assert/strict';
import { escapeTelegramMarkdownV2 } from '../src/utils/telegram-markdown.js';

function run(name, fn) {
	try {
		fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

run('escapes markdown v2 control characters that can break editMessageText', () => {
	const source = 'ACME *Prime* [offer] (RUB) #1 - done! path\\name';
	const escaped = escapeTelegramMarkdownV2(source);

	assert.equal(
		escaped,
		'ACME \\*Prime\\* \\[offer\\] \\(RUB\\) \\#1 \\- done\\! path\\\\name',
	);
});

console.log('All tests passed.');
