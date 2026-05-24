// Runtime tests for build-helpers.ts.
//
// Anchored next to the Phase B capability/connection coherence check, these
// tests cover Convention X: every formField.envVar MUST appear in
// manifest.credentials[].key. The exported `assertFormFieldEnvVarsDeclared`
// helper is the unit-test seam — buildPlugin() itself is too heavy to spin
// up under node:test (esbuild + tar + tmp fs), and the predicate is pure on
// its two inputs so a direct call gives full coverage.
//
// Runner: `node --test --experimental-strip-types src/build-helpers.test.ts`
// (the package "test" script invokes this on just this file because
// `host-api-types.test.ts` is a type-only fixture that intentionally trips
// strip-only mode via parameter properties from host-api-types.ts).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { assertFormFieldEnvVarsDeclared } from "./build-helpers.ts";
import type {
	ManifestCredential,
	ManifestFormField,
} from "./manifest-types.ts";

test("assertFormFieldEnvVarsDeclared: positive — envVar matches a declared credential key", () => {
	const formFields: ManifestFormField[] = [
		{
			id: "botToken",
			label: "Bot token",
			type: "password",
			configKey: "botToken",
			envVar: "TELEGRAM_BOT_API_KEY",
		},
	];
	const credentials: ManifestCredential[] = [
		{
			key: "TELEGRAM_BOT_API_KEY",
			label: "Telegram bot API key",
			type: "password",
		},
	];
	assert.doesNotThrow(() =>
		assertFormFieldEnvVarsDeclared(formFields, credentials),
	);
});

test("assertFormFieldEnvVarsDeclared: negative — envVar without a matching credential throws", () => {
	const formFields: ManifestFormField[] = [
		{
			id: "botToken",
			label: "Bot token",
			type: "password",
			configKey: "botToken",
			envVar: "TELEGRAM_BOT_API_KEY",
		},
	];
	const credentials: ManifestCredential[] = [];
	assert.throws(
		() => assertFormFieldEnvVarsDeclared(formFields, credentials),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(
				err.message,
				/formField "botToken" declares envVar "TELEGRAM_BOT_API_KEY" but no manifest credential declares that key/,
			);
			return true;
		},
	);
});
